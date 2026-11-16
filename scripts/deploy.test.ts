import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'
import { acquireLock, captureCurrentAssets, checkCheckout, cleanChildEnvironment, commitRelease, inspectArtifact, runDeployment, validateRegistryConfig, validateRegistryPins } from './deploy.ts'
import { mergeRetainedAssets } from './retention.ts'
import type { RetentionResult } from './retention.ts'

const execFileAsync = promisify(execFile)

const HASHED_NAME = /\.[A-Za-z0-9_-]{8,}\.[^/]+$/
const temporary: string[] = []

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wseffect-deploy-test-'))
  temporary.push(path)
  return path
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout.trim()
}

async function repository(): Promise<{ root: string; sha: string }> {
  const root = await tempDir()
  await git(root, 'init', '--initial-branch=main')
  await git(root, 'config', 'user.email', 'deploy-test@example.invalid')
  await git(root, 'config', 'user.name', 'Deploy Test')
  await writeFile(join(root, 'tracked.txt'), 'tracked\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-m', 'fixture')
  const sha = await git(root, 'rev-parse', 'HEAD')
  const remote = `${root}-origin.git`
  temporary.push(remote)
  await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-u', 'origin', 'main')
  await git(root, 'fetch', 'origin', 'main')
  return { root, sha }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('checkout gate accepts only clean current main', async () => {
  const { root, sha } = await repository()
  assert.equal(await checkCheckout(root), sha)
})

test('checkout gate rejects untracked files', async () => {
  const { root } = await repository()
  await writeFile(join(root, 'untracked.txt'), 'user data')
  await assert.rejects(checkCheckout(root), /dirty/)
})

test('checkout gate rejects a non-main branch', async () => {
  const { root } = await repository()
  await git(root, 'switch', '-c', 'release')
  await assert.rejects(checkCheckout(root), /main/)
})

test('checkout gate rejects a head behind freshly fetched origin/main', async () => {
  const { root } = await repository()
  await writeFile(join(root, 'later.txt'), 'later\n')
  await git(root, 'add', 'later.txt')
  await git(root, 'commit', '-m', 'later')
  await git(root, 'push', 'origin', 'main')
  await git(root, 'reset', '--hard', 'HEAD~1')
  await assert.rejects(checkCheckout(root), /origin\/main|stale|HEAD/)
  await git(root, 'reset', '--hard', 'origin/main')
})

test('deploy lock excludes concurrent writers and releases only its own lock', async () => {
  const root = await tempDir()
  const release = await acquireLock(root)
  await assert.rejects(acquireLock(root), /locked/)
  await release()
  const releaseAgain = await acquireLock(root)
  await releaseAgain()
})

test('subprocess environment strips inherited Cloudflare credentials', () => {
  const clean = cleanChildEnvironment({
    CLOUDFLARE_API_TOKEN: 'secret-value',
    CF_API_TOKEN: 'other-secret',
    WRANGLER_API_TOKEN: 'third-secret',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    NPM_CONFIG_REGISTRY: 'https://example.invalid/',
    'npm_config_@wsagency:registry': 'https://example.invalid/',
    OTHER: 'ok',
  })
  assert.equal(clean.CLOUDFLARE_API_TOKEN, undefined)
  assert.equal(clean.CF_API_TOKEN, undefined)
  assert.equal(clean.WRANGLER_API_TOKEN, undefined)
  assert.equal(clean.NPM_CONFIG_REGISTRY, undefined)
  assert.equal(clean['npm_config_@wsagency:registry'], undefined)
  assert.equal(clean.CLOUDFLARE_ACCOUNT_ID, 'account')
  assert.equal(clean.OTHER, 'ok')
})

test('artifact inspection rejects absolute workspace paths and credential-like content without exposing bytes', async () => {
  const root = await tempDir()
  await mkdir(join(root, '_astro'), { recursive: true })
  await writeFile(join(root, 'index.html'), `source ${root}/private`)
  await assert.rejects(inspectArtifact(root, root), /host path/i)
  await writeFile(join(root, 'index.html'), 'CLOUDFLARE_API_TOKEN=secret-value')
  await assert.rejects(inspectArtifact(root, root), (error: unknown) => {
    assert.match((error as Error).message, /credential/i)
    assert.equal((error as Error).message.includes('secret-value'), false)
    return true
  })
})

test('registry pins reject a workspace dependency', async () => {
  const root = await tempDir()
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@wsagency/wseffect-app': 'workspace:*' } }))
  await writeFile(join(root, 'pnpm-lock.yaml'), 'importers:\n  .:\n    dependencies:\n      @wsagency/wseffect-app:\n        specifier: workspace:*\n        version: link:../app\n')
  await assert.rejects(validateRegistryPins(root), /workspace|registry|pin/i)
})
test('registry configuration rejects project-level nonregistry endpoints', async () => {
  const root = await tempDir()
  await writeFile(join(root, '.npmrc'), '@wsagency:registry=https://example.invalid/\n')
  await assert.rejects(validateRegistryConfig(root), /npm registry/i)
})

test('dry-run completes local validation without reading credentials or deploying', async () => {
  const { root } = await repository()
  let secretReads = 0
  let remoteDeploys = 0
  await assert.rejects(runDeployment({
    root,
    dryRun: true,
    readToken: async () => { secretReads++; throw new Error('must not read') },
    deploy: async () => { remoteDeploys++ },
  }), /package\.json|registry|lock|worktree|Astro|site/i)
  assert.equal(secretReads, 0)
  assert.equal(remoteDeploys, 0)
  assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'tracked\n')
})
test('release snapshots contain only current build assets and retain exactly the prior three releases', async () => {
  const root = await tempDir()
  const releaseStore = join(root, 'releases')
  const releases = ['a', 'b', 'c', 'd', 'e']
  let finalRetention: RetentionResult | undefined

  for (const letter of releases) {
    const sha = letter.repeat(40)
    const out = join(root, `out-${letter}`)
    const astro = join(out, '_astro')
    await mkdir(astro, { recursive: true })
    const assetName = `${letter}.${letter.repeat(8)}.js`
    await writeFile(join(astro, assetName), `${letter} original bundle`)
    await writeFile(join(astro, `${letter}.js.map`), 'non-hashed map')
    const snapshot = join(root, `snapshot-${letter}`)
    await captureCurrentAssets(astro, snapshot)
    finalRetention = await mergeRetainedAssets(out, releaseStore, sha, 3)
    if (letter === 'e') {
      assert.ok(finalRetention)
      const mergedNames = await readdir(astro)
      assert.deepEqual(mergedNames.filter((name) => HASHED_NAME.test(name)).sort(), ['b.bbbbbbbb.js', 'c.cccccccc.js', 'd.dddddddd.js', 'e.eeeeeeee.js'])
      assert.deepEqual(finalRetention.releases, ['e'.repeat(40), 'd'.repeat(40), 'c'.repeat(40), 'b'.repeat(40)])
      assert.deepEqual(finalRetention.retainedAssets.map((asset) => asset.sourceSha), ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)])
      assert.equal(mergedNames.includes('a.aaaaaaaa.js'), false)

    }
    await commitRelease(snapshot, releaseStore, sha)
  }

  for (const letter of releases) {
    const names = await readdir(join(releaseStore, letter.repeat(40), '_astro'))
    assert.deepEqual(names, [`${letter}.${letter.repeat(8)}.js`])
  }
  const manifest = JSON.parse(await readFile(join(releaseStore, 'releases.json'), 'utf8')) as { releases: string[] }
  assert.deepEqual(manifest.releases, ['e'.repeat(40), 'd'.repeat(40), 'c'.repeat(40), 'b'.repeat(40), 'a'.repeat(40)])
})
