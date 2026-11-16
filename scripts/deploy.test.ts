import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'
import {
  acquireLock,
  captureCurrentAssets,
  checkCheckout,
  cleanChildEnvironment,
  commitRelease,
  inspectArtifact,
  normalizeCanonicalRoute,
  normalizeGeneratedMarkdownPath,
  parseWranglerDeploymentOutput,
  recordSmokeResult,
  runCommand,
  runDeployment,
  smokeProduction,
  validateRegistryConfig,
  validateRegistryPins,
  withDeploymentLock,
} from './deploy.ts'
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
  await git(root, 'init', '--bare', remote)
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

test('deployment lock is released after successful and failed guarded work', async () => {
  for (const shouldFail of [false, true]) {
    const root = await tempDir()
    const operation = async () => {
      assert.ok((await readFile(join(root, 'deploy.lock'), 'utf8')).includes(String(process.pid)))
      if (shouldFail) throw new Error('guarded work failed')
      return 'dry-run complete'
    }
    if (shouldFail) await assert.rejects(withDeploymentLock(root, operation), /guarded work failed/)
    else assert.equal(await withDeploymentLock(root, operation), 'dry-run complete')
    await assert.rejects(readFile(join(root, 'deploy.lock')), { code: 'ENOENT' })
    const release = await acquireLock(root)
    await release()
  }
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

test('failed command exposes stdout and stderr diagnostics without credential leaks', async () => {
  const root = await tempDir()
  const secret = 'test-cloudflare-token-do-not-leak'
  await writeFile(join(root, 'fail.mjs'), [
    "process.stdout.write('Playwright assertion failed: expected heading\\n')",
    "process.stdout.write('CLOUDFLARE_API_TOKEN=' + process.env.CLOUDFLARE_API_TOKEN + '\\n')",
    "process.stderr.write('authorization: Bearer ' + process.env.CLOUDFLARE_API_TOKEN + '\\n')",
    'process.exit(23)',
  ].join('\n'))
  await assert.rejects(
    runCommand(process.execPath, [join(root, 'fail.mjs')], { cwd: root, env: { CLOUDFLARE_API_TOKEN: secret } }),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /Playwright assertion failed: expected heading/)
      assert.match(message, /stdout:/)
      assert.match(message, /stderr:/)
      assert.match(message, /CLOUDFLARE_API_TOKEN=\[redacted\]/)
      assert.match(message, /authorization: Bearer \[redacted\]/)
      assert.equal(message.includes(secret), false)
      return true
    },
  )
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

test('generated route entries normalize relative Markdown twins without allowing traversal', () => {
  assert.equal(normalizeCanonicalRoute('/app/'), '/app/')
  assert.equal(normalizeCanonicalRoute('/'), '/')
  assert.equal(normalizeGeneratedMarkdownPath('app/index.md'), '/app/index.md')
  assert.equal(normalizeGeneratedMarkdownPath('/app/index.md'), '/app/index.md')
  assert.throws(() => normalizeGeneratedMarkdownPath('../secret.md'), /unsafe Markdown path/)
  assert.throws(() => normalizeCanonicalRoute('/app/%2e%2e/'), /unsafe canonical route/)
})

test('Wrangler output parser captures the exact Worker version identifier', () => {
  const versionId = 'v1-abc123'
  const output = [
    JSON.stringify({ type: 'wrangler-session', version: 1 }),
    JSON.stringify({ type: 'deploy', worker_name: 'wseffect-web', version_id: versionId }),
  ].join('\n')
  assert.deepEqual(parseWranglerDeploymentOutput(output), { workerVersionId: versionId })
  assert.throws(() => parseWranglerDeploymentOutput(JSON.stringify({ type: 'deploy', worker_name: 'wseffect-web', version_id: null })), /version identifier/)
})

test('production smoke checks canonical Markdown negotiation, its twin, and cache policy', async () => {
  const expectedSha = 'a'.repeat(40)
  const requests: { path: string; host: string; method: string; accept: string | null }[] = []
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init.method ?? 'GET'
    const accept = new Headers(init.headers).get('accept')
    requests.push({ path: url.pathname, host: url.hostname, method, accept })
    if (url.hostname === 'www.wseffect.com') return new Response(null, { status: 301, headers: { location: `https://wseffect.com${url.pathname}${url.search}` } })
    if (url.pathname === '/version.json') return new Response(JSON.stringify({ sha: expectedSha }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' } })
    if (url.pathname === '/robots.txt') return new Response('Sitemap: https://wseffect.com/sitemap.xml', { headers: { 'cache-control': 'no-cache' } })
    if (url.pathname === '/sitemap.xml') return new Response('<urlset><url><loc>https://wseffect.com/</loc></url></urlset>', { headers: { 'cache-control': 'no-cache' } })
    if (url.pathname === '/_astro/app.abcdef123456.js') return new Response('bundle', { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    if (url.pathname === '/guide/' && accept === 'text/markdown') {
      return new Response(method === 'HEAD' ? null : '# Guide', { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache', vary: 'Accept, Origin' } })
    }
    if (url.pathname === '/guide/') return new Response('<html>Guide</html>', { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } })
    if (url.pathname === '/guide/index.md') return new Response('# Guide', { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' } })
    if (url.pathname === '/__wseffect-deploy-smoke-404__' || url.pathname === '/_astro/__wseffect-deploy-smoke-missing__.js') return new Response('not found', { status: 404 })
    return new Response('<html>Home</html>', { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } })
  }
  await smokeProduction({
    baseUrl: 'https://wseffect.com',
    retainedPaths: ['/_astro/app.abcdef123456.js'],
    docsPath: '/guide/',
    markdownPath: 'guide/index.md',
    expectedSha,
    fetcher,
  })
  assert.deepEqual(requests.filter(({ path }) => path === '/guide/').map(({ method, accept }) => [method, accept]), [
    ['GET', null],
    ['GET', 'text/markdown'],
    ['HEAD', 'text/markdown'],
  ])
  assert.ok(requests.some(({ path, method }) => path === '/guide/index.md' && method === 'GET'))
})

test('release receipt records smoke success and failure', async () => {
  const receiptPath = join(await tempDir(), 'a'.repeat(40) + '.receipt.json')
  const receipt = {
    sha: 'a'.repeat(40),
    siteVersion: '0.1.0-rc.1',
    workerVersionId: 'bc11a111-8a88-4d2f-8be8-d9fd6e345f57',
    deployedAt: '2026-11-16T00:00:00.000Z',
    smoke: { status: 'pending' as const },
  }
  await recordSmokeResult(receiptPath, receipt, async () => {})
  assert.equal((JSON.parse(await readFile(receiptPath, 'utf8')) as typeof receipt).smoke.status, 'passed')
  await assert.rejects(recordSmokeResult(receiptPath, receipt, async () => { throw new Error('smoke failed') }), /smoke failed/)
  assert.equal((JSON.parse(await readFile(receiptPath, 'utf8')) as typeof receipt).smoke.status, 'failed')
})

test('dry-run avoids credentials and releases its lock when validation fails', async () => {
  const { root } = await repository()
  const deploymentTmp = await tempDir()
  const releaseStore = await tempDir()
  const previousTmp = process.env.WSEFFECT_DEPLOY_TMP
  const previousStore = process.env.WSEFFECT_RELEASE_STORE
  process.env.WSEFFECT_DEPLOY_TMP = deploymentTmp
  process.env.WSEFFECT_RELEASE_STORE = releaseStore
  let secretReads = 0
  let remoteDeploys = 0
  try {
    await assert.rejects(runDeployment({
      root,
      dryRun: true,
      readToken: async () => { secretReads++; throw new Error('must not read') },
      deploy: async () => { remoteDeploys++; return { workerVersionId: '00000000-0000-0000-0000-000000000000' } },
    }), /ENOENT.*package\.json/i)
  } finally {
    if (previousTmp === undefined) delete process.env.WSEFFECT_DEPLOY_TMP
    else process.env.WSEFFECT_DEPLOY_TMP = previousTmp
    if (previousStore === undefined) delete process.env.WSEFFECT_RELEASE_STORE
    else process.env.WSEFFECT_RELEASE_STORE = previousStore
  }
  assert.equal(secretReads, 0)
  assert.equal(remoteDeploys, 0)
  assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'tracked\n')
  await assert.rejects(readFile(join(deploymentTmp, 'deploy.lock')), { code: 'ENOENT' })
  const release = await acquireLock(deploymentTmp)
  await release()
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
