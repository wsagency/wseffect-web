import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VERSION = '0.1.0-rc.1'
const STARTER_IDS = ['minimal', 'full'] as const
export type StarterId = typeof STARTER_IDS[number]
export type StarterArtifact = { readonly id: StarterId; readonly href: string; readonly sha256: string }
const PACKAGE_NAMES = [
  '@wsagency/wseffect-app',
  '@wsagency/wseffect-foldkit',
  '@wsagency/wseffect-foldkit-ui',
  '@wsagency/wseffect-themes',
  '@wsagency/wseffect-vite-plugin',
]

const BUILD_ID_PATTERN = /^[0-9a-f]{7,64}$/

async function resolveBuildId(siteRoot: string): Promise<string> {
  const configured = process.env.WSEFFECT_BUILD_ID
  if (configured !== undefined) {
    if (!BUILD_ID_PATTERN.test(configured)) {
      fail('WSEFFECT_BUILD_ID must be 7–64 lowercase hexadecimal characters')
    }
    return configured
  }

  let repositoryRoot: string
  try {
    const { stdout } = await execFileAsync('git', ['-C', siteRoot, 'rev-parse', '--show-toplevel'])
    repositoryRoot = resolve(stdout.trim())
  } catch {
    fail(`cannot derive build ID: ${siteRoot} is not an initialized Git repository; set WSEFFECT_BUILD_ID to a stable 7–64 character lowercase hexadecimal source ID`)
  }
  if (repositoryRoot !== resolve(siteRoot)) {
    fail(`cannot derive build ID: ${siteRoot} is not the Git repository root (${repositoryRoot}); refusing to use an ancestor repository`)
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', siteRoot, 'rev-parse', '--verify', 'HEAD^{commit}'])
    const buildId = stdout.trim()
    if (BUILD_ID_PATTERN.test(buildId)) return buildId
  } catch {
    // An initialized repository without a commit has no source identity to use.
  }
  fail(`cannot derive build ID: ${siteRoot} has no valid Git HEAD; create a commit or set WSEFFECT_BUILD_ID to a stable 7–64 character lowercase hexadecimal source ID`)
}
const LOCAL_PROTOCOL = /^(?:workspace:|link:|file:|git(?:\+|:)|https?:)/i

function fail(message: string): never {
  throw new Error(`[starters] ${message}`)
}

async function assertRegistryManifest(siteRoot: string, id: StarterId, manifest: Record<string, any>): Promise<void> {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string' || LOCAL_PROTOCOL.test(version)) {
      fail(`${id}: dependency ${name} uses a non-registry specification (${String(version)})`)
    }
  }
  const requiredPackages = id === 'minimal' ? PACKAGE_NAMES.slice(1) : PACKAGE_NAMES
  for (const name of requiredPackages) {
    if (dependencies[name] !== VERSION) fail(`${id}: expected direct ${name}@${VERSION}; found ${String(dependencies[name])}`)
  }
  for (const packageName of requiredPackages) {
    let packageManifest: Record<string, any>
    try {
      packageManifest = JSON.parse(await readFile(join(siteRoot, 'node_modules', packageName, 'package.json'), 'utf8'))
    } catch {
      fail(`cannot inspect installed registry peer metadata for ${packageName}; install site dependencies first`)
    }
    for (const [peer, required] of Object.entries(packageManifest.peerDependencies ?? {})) {
      const provided = dependencies[peer]
      if (provided === undefined) fail(`${id}: missing peer ${peer}@${required} required by ${packageName}`)
      if (!peerRangeMatches(String(required), String(provided))) {
        fail(`${id}: ${packageName} requires peer ${peer}@${required}, but starter declares ${String(provided)}`)
      }
    }
  }
  if (id === 'full') {
    for (const [name, version] of Object.entries({ vite: '8.3.4', 'vite-plugin-pwa': '2.0.0' })) {
      if (manifest.devDependencies?.[name] !== version) fail(`full: required app peer ${name}@${version} must be a direct devDependency`)
    }
  } else if (manifest.devDependencies?.vite !== '8.3.4') {
    fail('minimal: vite@8.3.4 must be a direct devDependency')
  }
}

// This small matcher intentionally supports the exact and caret peer ranges used by the public packages.
function peerRangeMatches(required: string, provided: string): boolean {
  if (required === provided) return true
  if (!required.startsWith('^')) return false
  const base = required.slice(1).split('.').map(Number)
  const value = provided.split('.').map(Number)
  if (base.length !== 3 || value.length !== 3 || base.some(Number.isNaN) || value.some(Number.isNaN)) return false
  return value[0] === base[0] && (value[1] > base[1] || (value[1] === base[1] && value[2] >= base[2]))
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(directory, entry.name)
      const metadata = await stat(path)
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) found.push(path)
      else fail(`starter source contains unsupported filesystem entry ${path}`)
    }
  }
  await visit(root)
  return found
}

async function createArchive(source: string, destination: string): Promise<void> {
  const files = await listFiles(source)
  if (files.length === 0) fail(`starter source is empty: ${source}`)
  await mkdir(dirname(destination), { recursive: true })
  await execFileAsync('tar', [
    '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--format=posix', '--pax-option=delete=atime,delete=ctime', '-czf', destination,
    '-C', source, '.',
  ])
}

async function digest(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

export async function buildStarters(siteRoot: string): Promise<readonly StarterArtifact[]> {
  const root = resolve(siteRoot)
  const artifacts: StarterArtifact[] = []
  for (const id of STARTER_IDS) {
    const source = join(root, 'src', 'starters', id)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    await assertRegistryManifest(root, id, manifest)
    const filename = `wseffect-${id}-${VERSION}.tgz`
    const destination = join(root, 'public', 'starters', filename)
    await createArchive(source, destination)
    artifacts.push({ id, href: `/starters/${filename}`, sha256: await digest(destination) })
  }
  return artifacts
}

function validateTarListing(listing: string, verbose: string, archive: string): string[] {
  const entries = listing.split('\n').filter(Boolean)
  const details = verbose.split('\n').filter(Boolean)
  if (entries.length !== details.length) fail(`${archive}: tar listing metadata count mismatch`)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '')
    if (entry.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      fail(`${archive}: unsafe archive path ${entry}`)
    }
    if (!/^[-d]/.test(details[index]!)) fail(`${archive}: links or special files are not allowed (${entry})`)
  }
  return entries
}

async function extractSafely(archive: string, destination: string): Promise<void> {
  const { stdout: listing } = await execFileAsync('tar', ['-tzf', archive])
  const { stdout: verbose } = await execFileAsync('tar', ['-tvzf', archive])
  const entries = validateTarListing(listing, verbose, archive)
  if (!entries.some((entry) => entry === './package.json' || entry === 'package.json')) {
    fail(`${archive}: package.json missing at archive root`)
  }
  await mkdir(destination, { recursive: true })
  await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', destination])
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  tempRoot: string,
  buildId?: string,
): Promise<void> {
  const env = { ...process.env }
  delete env.WSEFFECT_BUILD_ID
  env.TMPDIR = tempRoot
  if (buildId !== undefined) env.WSEFFECT_BUILD_ID = buildId
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (stdout.trim()) process.stdout.write(stdout)
    if (stderr.trim()) process.stderr.write(stderr)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`${label} failed: ${detail}`)
  }
}

export async function checkStarters(siteRoot: string): Promise<void> {
  const root = resolve(siteRoot)
  const buildId = await resolveBuildId(root)
  const downloadRoot = join(root, 'out', 'starters')
  const tempRoot = resolve(process.env.TMPDIR ?? join(homedir(), '.cache/wseffect-work/release-web/tmp'))
  await mkdir(tempRoot, { recursive: true })
  const workRoot = await mkdtemp(join(tempRoot, 'wseffect-starters-check-'))
  try {
    for (const id of STARTER_IDS) {
      const archive = join(downloadRoot, `wseffect-${id}-${VERSION}.tgz`)
      try {
        await stat(archive)
      } catch {
        fail(`actual built download is missing: ${archive}; run the site build first`)
      }
      const project = join(workRoot, id)
      await extractSafely(archive, project)
      const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
      await assertRegistryManifest(root, id, manifest)
      await run('pnpm', ['install', '--frozen-lockfile'], project, `${id} frozen registry install`, tempRoot)
      if (id === 'full') await run('pnpm', ['exec', 'wseffect-codegen', '--check', '.'], project, 'full codegen --check', tempRoot)
      await run('pnpm', ['build'], project, `${id} build`, tempRoot, id === 'full' ? buildId : undefined)
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}


async function main(args: string[]): Promise<void> {
  const siteRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
  if (args.length === 0) {
    const artifacts = await buildStarters(siteRoot)
    for (const artifact of artifacts) console.log(`${artifact.id} ${artifact.href} sha256=${artifact.sha256}`)
    return
  }
  if (args.length === 1 && args[0] === '--check') {
    await checkStarters(siteRoot)
    return
  }
  fail('usage: node scripts/starters.ts [--check]')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
