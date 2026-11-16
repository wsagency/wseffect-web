import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeRetainedAssets } from './retention.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SITE_VERSION = '0.1.0-rc.1'
const PACKAGE_PINS = Object.freeze({
  '@wsagency/wseffect-app': SITE_VERSION,
  '@wsagency/wseffect-foldkit': SITE_VERSION,
  '@wsagency/wseffect-foldkit-ui': SITE_VERSION,
  '@wsagency/wseffect-themes': SITE_VERSION,
  '@wsagency/wseffect-vite-plugin': SITE_VERSION,
})
const NODE_VERSION = '24.21.0'
const PNPM_VERSION = '11.5.0'
const WRANGLER_VERSION = '4.149.0'
const REGISTRY_URL = 'https://registry.npmjs.org/'
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const SECRET_KEYS = /^(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|WRANGLER_API_TOKEN)$/i
const WORKER_VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOKEN_TEXT = /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|WRANGLER_API_TOKEN)\s*[:=]\s*[^\s"']+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization\s*:\s*(?:bearer|basic)\s+[^\s"']+|https?:\/\/[^\s/:@]+:[^\s/@]+@/i

function safeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (SECRET_KEYS.test(key) || /^(?:NPM|PNPM)_CONFIG_.*REGISTRY$/i.test(key)) delete env[key]
  }
  return env
}

export function cleanChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return safeEnv(source)
}

export async function runCommand(commandName: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(commandName, [...args], {
      cwd: options.cwd,
      env: options.env ?? safeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => reject(new Error(`${commandName} could not start: ${error.message}`)))
    child.once('close', (status, signal) => {
      if (status !== 0) {
        const output = [
          stdout.length > 0 ? `stdout:\n${Buffer.concat(stdout).toString('utf8').trim()}` : '',
          stderr.length > 0 ? `stderr:\n${Buffer.concat(stderr).toString('utf8').trim()}` : '',
        ].filter(Boolean).join('\n')
        const secrets = Object.entries(options.env ?? {})
          .filter(([key, value]) => SECRET_KEYS.test(key) && value)
          .map(([, value]) => value!)
        const details = redact(secrets.reduce((text, secret) => redact(text, secret), output))
        reject(new Error(`${commandName} ${args[0] ?? ''} failed (${signal ?? status})${details ? `:\n${details}` : ''}`))
        return
      }
      resolveCommand(Buffer.concat(stdout).toString('utf8').trim())
    })
  })
}

function redact(text: string, token?: string): string {
  const masked = token ? text.split(token).join('[redacted]') : text
  return masked
    .replace(/((?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|WRANGLER_API_TOKEN)\s*[:=]\s*)[^\s"']+/gi, '$1[redacted]')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[redacted private key]')
}

async function git(root: string, ...args: string[]): Promise<string> {
  return runCommand('git', args, { cwd: root })
}


export async function checkCheckout(root: string): Promise<string> {
  await git(root, 'fetch', '--prune', 'origin')
  const branch = await git(root, 'branch', '--show-current')
  if (branch !== 'main') throw new Error(`Deployment requires branch main; found ${branch || 'detached HEAD'}`)
  const status = await git(root, 'status', '--porcelain=v1', '--untracked-files=all')
  if (status) throw new Error('Deployment checkout is dirty (tracked or untracked paths); no changes were made')
  const [head, origin] = await Promise.all([git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'origin/main')])
  if (!SHA_PATTERN.test(head) || head !== origin) throw new Error(`Deployment checkout HEAD is not fresh origin/main (${head} != ${origin})`)
  return head
}

export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'deploy.lock')
  let handle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Deployment is already locked: ${path}`)
    throw error
  }
  const marker = `${process.pid}\n${Date.now()}\n`
  await handle.writeFile(marker)
  await handle.close()
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      if ((await readFile(path, 'utf8')) === marker) await rm(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function inside(path: string, root: string): boolean {
  const part = relative(root, path)
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
}
async function canonicalPath(path: string): Promise<string> {
  let cursor = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const parent = await realpath(cursor)
      return resolve(parent, ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.unshift(cursor.slice(parent === sep ? 1 : parent.length + 1))
      cursor = parent
    }
  }
}

export async function validateRegistryPins(root: string, verifyInstalled = true): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const dependencies = manifest.dependencies
  if (!dependencies || typeof dependencies !== 'object') throw new Error('Production dependencies are missing')
  for (const [name, version] of Object.entries(PACKAGE_PINS)) {
    if ((dependencies as Record<string, unknown>)[name] !== version) throw new Error(`Wrong or missing registry pin for ${name}; expected ${version}`)
  }
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  const importer = lock.match(/(?:^|\n)  \.:\n([\s\S]*?)(?=\n  [^ ]|\npackages:)/)?.[1]
  if (!importer) throw new Error('pnpm-lock.yaml has no root importer')
  for (const [name, version] of Object.entries(PACKAGE_PINS)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const item = importer.match(new RegExp(`(?:^|\\n)      ['"]?${escaped}['"]?:\\n        specifier: ([^\\n]+)\\n        version: ([^\\n]+)`))
    if (!item || item[1].trim() !== version || !item[2].trim().startsWith(`${version}(`) && item[2].trim() !== version) {
      throw new Error(`Lockfile pin is not an exact published registry version for ${name}`)
    }
    const lockEntry = lock.match(new RegExp(`(?:^|\\n)  ['"]?${escaped}@${version.replaceAll('.', '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=\\n  ['"]?[^ ]+@|\\npackages:|\\n  [^ ]+@)`))?.[1]
    if (!lockEntry || !/resolution:\s*\{[^}]*integrity:\s*sha\d+-/s.test(lockEntry) || /tarball:\s*(?!https:\/\/registry\.npmjs\.org\/)/.test(lockEntry)) {
      throw new Error(`Lockfile does not pin ${name} to an integrity-verified npm registry package`)
    }
    if (verifyInstalled) {
      const installed = JSON.parse(await readFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (installed.name !== name || installed.version !== version) throw new Error(`Installed manifest does not match registry pin for ${name}`)
    }
  }
}
async function validateWranglerPin(root: string, verifyInstalled = true): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, unknown> }
  if (manifest.devDependencies?.wrangler !== WRANGLER_VERSION) throw new Error(`Wrangler must be pinned to ${WRANGLER_VERSION}`)
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  const importer = lock.match(/(?:^|\n)  \.:\n([\s\S]*?)(?=\n  [^ ]|\npackages:)/)?.[1]
  const item = importer?.match(/(?:^|\n)      wrangler:\n        specifier: ([^\n]+)\n        version: ([^\n]+)/)
  if (!item || item[1].trim() !== WRANGLER_VERSION || !item[2].trim().startsWith(`${WRANGLER_VERSION}(`)) {
    throw new Error('pnpm lockfile does not pin Wrangler to the configured registry release')
  }
  const entry = lock.match(/(?:^|\n)  wrangler@4\.149\.0[^\n]*\n([\s\S]*?)(?=\n  ['"]?[^ ]+@|\npackages:|\n  [^ ]+@)/)?.[1]
  if (!entry || !/resolution:\s*\{[^}]*integrity:\s*sha\d+-/s.test(entry) || /tarball:\s*(?!https:\/\/registry\.npmjs\.org\/)/.test(entry)) {
    throw new Error('Wrangler lockfile entry is not integrity-verified from the npm registry')
  }
  if (verifyInstalled) {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', 'wrangler', 'package.json'), 'utf8')) as { name?: string; version?: string }
    if (installed.name !== 'wrangler' || installed.version !== WRANGLER_VERSION) throw new Error('Installed Wrangler package does not match the pinned version')
  }
}
export async function validateRegistryConfig(root: string): Promise<void> {
  let config = ''
  try {
    config = await readFile(join(root, '.npmrc'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const line of config.split(/\r?\n/)) {
    const setting = line.match(/^\s*(?:@[^:\s]+:)?registry\s*=\s*(.*?)\s*$/i)
    if (setting && setting[1] !== REGISTRY_URL) throw new Error('Project .npmrc must not redirect package resolution away from the public npm registry')
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${relative(root, path)}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(path)
      else throw new Error(`Artifact contains an unsupported file: ${relative(root, path)}`)
    }
  }
  await visit(root)
  return result
}

export async function inspectArtifact(outDir: string, workspaceRoot: string): Promise<void> {
  const home = resolve(homedir())
  const root = resolve(workspaceRoot)
  const forbiddenPaths = [...new Set([root, home, '/home/', '/Users/', 'C:\\Users\\'].filter(Boolean))]
  for (const file of await walkFiles(outDir)) {
    const bytes = await readFile(file)
    const text = bytes.toString('utf8')
    if (TOKEN_TEXT.test(text)) throw new Error(`Artifact contains credential-like material: ${relative(outDir, file)}`)
    for (const path of forbiddenPaths) {
      if (text.includes(path)) throw new Error(`Artifact contains a host path: ${relative(outDir, file)}`)
    }
    if (text.includes('CLOUDFLARE_API_TOKEN') || text.includes('CF_API_TOKEN')) throw new Error(`Artifact contains a credential key: ${relative(outDir, file)}`)
  }
}

export function normalizeCanonicalRoute(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error('generated/routes.json contains an invalid canonical route')
  }
  if (value === '/') return '/'
  if (!value.endsWith('/')) throw new Error('generated/routes.json route must end in a slash')
  const segments = value.slice(1, -1).split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || unsafeEncodedSegment(segment))) {
    throw new Error('generated/routes.json contains an unsafe canonical route')
  }
  return `/${segments.join('/')}/`
}

export function normalizeGeneratedMarkdownPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error('generated/routes.json contains an invalid Markdown path')
  }
  const relativePath = value.startsWith('/') ? value.slice(1) : value
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || unsafeEncodedSegment(segment))) {
    throw new Error('generated/routes.json contains an unsafe Markdown path')
  }
  return `/${segments.join('/')}`
}

function unsafeEncodedSegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment)
    return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  } catch {
    return true
  }
}

type GeneratedRoute = Readonly<{ route: string; markdownPath: string }>

async function validateOutput(root: string, sha: string): Promise<{ markdownPath: string; docsPath: string; version: string }> {
  const out = join(root, 'out')
  const versionDoc = JSON.parse(await readFile(join(out, 'version.json'), 'utf8')) as { sha?: unknown; version?: unknown }
  if (versionDoc.sha !== sha) throw new Error(`Build version SHA does not match guarded source commit ${sha}`)
  if (versionDoc.version !== SITE_VERSION) throw new Error('Unexpected website version in out/version.json')
  const routes = JSON.parse(await readFile(join(root, 'generated', 'routes.json'), 'utf8')) as Record<string, unknown>
  if (!routes || typeof routes !== 'object' || Array.isArray(routes) || Object.keys(routes).length === 0) throw new Error('generated/routes.json is not a non-empty route map')
  const normalizedRoutes: GeneratedRoute[] = Object.entries(routes).map(([route, markdown]) => ({
    route: normalizeCanonicalRoute(route),
    markdownPath: normalizeGeneratedMarkdownPath(markdown),
  }))
  for (const entry of normalizedRoutes) {
    const routeFiles = entry.route === '/' ? ['index.html'] : [...entry.route.slice(1, -1).split('/'), 'index.html']
    await lstat(join(out, ...routeFiles))
    await lstat(join(out, ...entry.markdownPath.slice(1).split('/')))
  }
  for (const required of ['index.html', 'robots.txt', 'sitemap.xml', 'version.json']) await lstat(join(out, required))
  await lstat(join(root, 'worker', 'index.ts'))
  const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as {
    name?: unknown; main?: unknown; assets?: { directory?: unknown; binding?: unknown; run_worker_first?: unknown }
  }
  if (wrangler.name !== 'wseffect-web' || wrangler.main !== 'worker/index.ts' || wrangler.assets?.directory !== './out' || wrangler.assets.binding !== 'ASSETS' || wrangler.assets.run_worker_first !== true) {
    throw new Error('wrangler.jsonc does not describe the guarded static-assets Worker')
  }
  if ((await walkFiles(join(out, '_astro'))).length === 0) throw new Error('Built output has no deployable Astro assets')
  await inspectArtifact(out, root)
  const docsEntry = normalizedRoutes.find(({ route }) => route !== '/')
  if (!docsEntry) throw new Error('Generated route map has no docs route to smoke-test')
  return { docsPath: docsEntry.route, markdownPath: docsEntry.markdownPath, version: String(versionDoc.version) }
}

export interface SmokeOptions {
  readonly baseUrl?: string
  readonly retainedPaths: readonly string[]
  readonly docsPath: string
  readonly markdownPath: string
  readonly expectedSha: string
  readonly fetcher?: typeof fetch
}

function responseVariesOnAccept(response: Response): boolean {
  return (response.headers.get('vary') ?? '').split(',').some((value) => value.trim().toLowerCase() === 'accept')
}

function requireNoCache(response: Response, path: string): void {
  if (response.headers.get('cache-control') !== 'no-cache') throw new Error(`Production response at ${path} must use Cache-Control: no-cache`)
}

export async function smokeProduction(options: SmokeOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const base = (options.baseUrl ?? 'https://wseffect.com').replace(/\/$/, '')
  const docsPath = normalizeCanonicalRoute(options.docsPath)
  const markdownPath = normalizeGeneratedMarkdownPath(options.markdownPath)
  const get = async (path: string, init?: RequestInit) => fetcher(`${base}${path}`, { redirect: 'manual', ...init })
  const root = await get('/')
  if (root.status !== 200 || !(root.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Production smoke failed at /')
  requireNoCache(root, '/')
  const docs = await get(docsPath)
  if (docs.status !== 200 || !(docs.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`Production smoke failed at ${docsPath}`)
  requireNoCache(docs, docsPath)
  const docsMarkdown = await get(docsPath, { headers: { Accept: 'text/markdown' } })
  if (docsMarkdown.status !== 200 || !(docsMarkdown.headers.get('content-type') ?? '').includes('text/markdown')) {
    throw new Error(`Production smoke failed at Markdown negotiation for ${docsPath}`)
  }
  requireNoCache(docsMarkdown, docsPath)
  if (!responseVariesOnAccept(docsMarkdown)) throw new Error('Production canonical Markdown response does not vary on Accept')
  const docsMarkdownHead = await get(docsPath, { method: 'HEAD', headers: { Accept: 'text/markdown' } })
  if (docsMarkdownHead.status !== 200 || !(docsMarkdownHead.headers.get('content-type') ?? '').includes('text/markdown')) {
    throw new Error(`Production smoke failed at canonical Markdown HEAD for ${docsPath}`)
  }
  requireNoCache(docsMarkdownHead, docsPath)
  if (!responseVariesOnAccept(docsMarkdownHead)) throw new Error('Production canonical Markdown HEAD does not vary on Accept')
  const markdownTwin = await get(markdownPath)
  if (markdownTwin.status !== 200 || !(markdownTwin.headers.get('content-type') ?? '').includes('text/markdown')) {
    throw new Error(`Production smoke failed at Markdown twin ${markdownPath}`)
  }
  requireNoCache(markdownTwin, markdownPath)
  const version = await get('/version.json')
  if (version.status !== 200 || !(version.headers.get('content-type') ?? '').includes('json')) throw new Error('Production smoke failed at /version.json')
  requireNoCache(version, '/version.json')
  const publishedVersion = await version.json() as { sha?: unknown }
  if (publishedVersion.sha !== options.expectedSha) throw new Error('Production version SHA does not match this deployment')
  const unknown = await get('/__wseffect-deploy-smoke-404__')
  if (unknown.status !== 404) throw new Error('Production smoke expected unknown extensionless route to return 404')
  const missingJs = await get('/_astro/__wseffect-deploy-smoke-missing__.js')
  if (missingJs.status !== 404) throw new Error('Production smoke expected missing JavaScript asset to return 404')
  for (const path of ['/robots.txt', '/sitemap.xml']) {
    const response = await get(path)
    requireNoCache(response, path)
    if (response.status !== 200) throw new Error(`Production smoke failed at ${path}`)
    const body = await response.text()
    const valid = path === '/robots.txt'
      ? body.includes('Sitemap: https://wseffect.com/sitemap.xml')
      : body.includes('<urlset') && body.includes('https://wseffect.com/')
    if (!valid) throw new Error(`Production smoke content is invalid at ${path}`)
  }
  if (options.retainedPaths.length) {
    const assetPath = options.retainedPaths[0]!
    const retained = await get(assetPath)
    if (retained.status !== 200) throw new Error(`Production smoke failed at retained asset ${assetPath}`)
    if (retained.headers.get('cache-control') !== 'public, max-age=31536000, immutable') {
      throw new Error(`Retained hashed asset ${assetPath} must use immutable Cache-Control`)
    }
  }
  const redirect = await fetcher('https://www.wseffect.com/deploy-smoke-path?q=preserved', { redirect: 'manual' })
  const location = redirect.headers.get('location')
  const target = location ? new URL(location) : undefined
  if (redirect.status !== 301 || !target || target.protocol !== 'https:' || target.hostname !== 'wseffect.com' || target.pathname !== '/deploy-smoke-path' || target.search !== '?q=preserved') {
    throw new Error('Production smoke failed at www 301 path/query redirect')
  }
}

export interface WorkerDeploymentResult {
  readonly workerVersionId: string
}

export function parseWranglerDeploymentOutput(output: string): WorkerDeploymentResult {
  const deployEvents: Record<string, unknown>[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error('Wrangler structured output is not valid ND-JSON')
    }
    if (event && typeof event === 'object' && (event as Record<string, unknown>).type === 'deploy'
      && (event as Record<string, unknown>).worker_name === 'wseffect-web') {
      deployEvents.push(event as Record<string, unknown>)
    }
  }
  if (deployEvents.length !== 1) throw new Error('Wrangler output must contain exactly one deployment event for wseffect-web')
  const versionId = deployEvents[0]!.version_id
  if (typeof versionId !== 'string' || !WORKER_VERSION_ID_PATTERN.test(versionId)) {
    throw new Error('Wrangler deployment event did not contain a valid Worker version identifier')
  }
  return { workerVersionId: versionId }
}

export interface DeploymentOptions {
  readonly root?: string
  readonly dryRun?: boolean
  readonly readToken?: () => Promise<string>
  readonly deploy?: (worktree: string, sha: string, token: string, accountId: string) => Promise<WorkerDeploymentResult>
}

async function readScopedToken(): Promise<string> {
  try {
    const token = process.env.WSEFFECT_TOKEN_SOURCE === 'pass'
      ? await runCommand('pass', ['show', 'wseffect-web/CLOUDFLARE_API_TOKEN'], { cwd: ROOT })
      : await runCommand('secret-tool', ['lookup', 'service', 'wseffect-web', 'key', 'CLOUDFLARE_API_TOKEN'], { cwd: ROOT })
    if (!token || /\s/.test(token)) throw new Error('Secret store returned an empty or invalid Cloudflare token')
    return token
  } catch {
    throw new Error('Cloudflare token lookup failed; verify the configured libsecret/pass entry without exposing its value')
  }
}

async function deployWithWrangler(
  worktree: string,
  sha: string,
  token: string,
  accountId: string,
  outputPath: string,
): Promise<WorkerDeploymentResult> {
  const childEnv = safeEnv()
  childEnv.CLOUDFLARE_API_TOKEN = token
  childEnv.CLOUDFLARE_ACCOUNT_ID = accountId
  childEnv.WRANGLER_OUTPUT_FILE_PATH = outputPath
  let outputCreated = false
  try {
    await writeFile(outputPath, '', { mode: 0o600, flag: 'wx' })
    outputCreated = true
    const output = await runCommand(process.execPath, [join(worktree, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--message', sha], { cwd: worktree, env: childEnv })
    console.log(redact(output, token))
    return parseWranglerDeploymentOutput(await readFile(outputPath, 'utf8'))
  } catch (error) {
    throw new Error(`Wrangler deployment or version capture failed. Do not assume production state; inspect Cloudflare and follow the rollback/stop procedure in docs/RELEASING.md. ${redact((error as Error).message, token)}`)
  } finally {
    delete childEnv.CLOUDFLARE_API_TOKEN
    if (outputCreated) await rm(outputPath, { force: true }).catch(() => undefined)
  }
}

export interface ReleaseReceipt {
  readonly sha: string
  readonly siteVersion: string
  readonly workerVersionId: string
  readonly deployedAt: string
  readonly smoke: Readonly<{ status: 'pending' | 'passed' | 'failed'; checkedAt?: string }>
}

async function writeReleaseReceipt(path: string, receipt: ReleaseReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let temporaryCreated = false
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    temporaryCreated = true
    await rename(temporaryPath, path)
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function recordSmokeResult(
  receiptPath: string,
  receipt: ReleaseReceipt,
  smoke: () => Promise<void>,
): Promise<void> {
  try {
    await smoke()
  } catch (error) {
    await writeReleaseReceipt(receiptPath, { ...receipt, smoke: { status: 'failed', checkedAt: new Date().toISOString() } })
    throw error
  }
  await writeReleaseReceipt(receiptPath, { ...receipt, smoke: { status: 'passed', checkedAt: new Date().toISOString() } })
}

const HASHED_FILENAME = /\.[A-Za-z0-9_-]{8,}\.[^/]+$/

export async function captureCurrentAssets(sourceAstro: string, snapshotAstro: string): Promise<void> {
  await mkdir(snapshotAstro, { recursive: false, mode: 0o700 })
  let copied = 0
  try {
    for (const file of await walkFiles(sourceAstro)) {
      if (!HASHED_FILENAME.test(file.split(sep).at(-1) ?? '')) continue
      const relativePath = relative(sourceAstro, file)
      const target = join(snapshotAstro, relativePath)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await copyFile(file, target, constants.COPYFILE_EXCL)
      copied++
    }
    if (copied === 0) throw new Error('Current build has no hashed Astro assets to snapshot')
  } catch (error) {
    await rm(snapshotAstro, { recursive: true, force: true })
    throw error
  }
}

export async function commitRelease(currentAstro: string, releaseStore: string, sha: string): Promise<void> {
  const releasesPath = join(releaseStore, 'releases.json')
  const existing = await readFile(releasesPath, 'utf8').then((text) => JSON.parse(text) as { releases: unknown[] }, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { releases: [] as unknown[] }
    throw error
  })
  if (!Array.isArray(existing.releases) || existing.releases.some((item) => typeof item !== 'string' || !SHA_PATTERN.test(item))) {
    throw new Error('Release store manifest is invalid; cannot record published release')
  }
  const releasePath = join(releaseStore, sha)
  const astroPath = join(releasePath, '_astro')
  await mkdir(releaseStore, { recursive: true, mode: 0o700 })
  await mkdir(astroPath, { recursive: true, mode: 0o700 })
  for (const file of await walkFiles(currentAstro)) {
    const relativePath = relative(currentAstro, file)
    const target = join(astroPath, relativePath)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(file, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const [source, copy] = await Promise.all([readFile(file), readFile(target)])
    if (!source.equals(copy)) throw new Error(`Existing release snapshot differs at ${relativePath}`)
  }
  const releases = [sha, ...existing.releases.filter((item) => item !== sha)]
  const temporaryManifest = `${releasesPath}.${process.pid}.tmp`
  await writeFile(temporaryManifest, `${JSON.stringify({ releases }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporaryManifest, releasesPath)
}
async function validateSnapshotCompatibility(currentAstro: string, releaseStore: string, sha: string): Promise<void> {
  const releasePath = join(releaseStore, sha)
  const releaseInfo = await lstat(releasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!releaseInfo) return
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()) throw new Error('Existing current-SHA release tree is not a real directory')
  const priorAstro = join(releasePath, '_astro')
  const info = await lstat(priorAstro).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Existing current-SHA snapshot is not a real _astro directory')
  const priorFiles = await walkFiles(priorAstro)
  const currentFiles = await walkFiles(currentAstro)
  if (priorFiles.length !== currentFiles.length) throw new Error('Current-SHA release snapshot differs from this build; refusing to overwrite or retain stale assets')
  for (const source of currentFiles) {
    const target = join(priorAstro, relative(currentAstro, source))
    const prior = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('Current-SHA release snapshot is missing a build asset')
      throw error
    })
    if (!(await readFile(source)).equals(prior)) throw new Error('Current-SHA release snapshot asset bytes differ; refusing overwrite')
  }
}

export async function withDeploymentLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const releaseLock = await acquireLock(directory)
  try {
    return await operation()
  } finally {
    await releaseLock()
  }
}

export async function runDeployment(options: DeploymentOptions = {}): Promise<void> {
  if (process.version !== `v${NODE_VERSION}`) throw new Error(`Deployment must run under Node ${NODE_VERSION}; found ${process.version}`)
  const root = await realpath(resolve(options.root ?? ROOT))
  const dryRun = options.dryRun ?? process.argv.includes('--dry-run')
  const baseCache = join(homedir(), '.cache', 'wseffect-work', 'release-web')
  const tempRoot = await canonicalPath(process.env.WSEFFECT_DEPLOY_TMP ?? join(baseCache, 'tmp'))
  const releaseStore = await canonicalPath(process.env.WSEFFECT_RELEASE_STORE ?? join(baseCache, 'releases'))
  if (inside(tempRoot, root) || inside(releaseStore, root) || inside(tempRoot, releaseStore) || inside(releaseStore, tempRoot)) {
    throw new Error('Deployment temp and release-store paths must be separate and outside the source repository')
  }
  return withDeploymentLock(tempRoot, async () => {
  let worktree: string | undefined
  let worktreeCreated = false
  let snapshotAstro: string | undefined
  let snapshotCaptured = false
  let deployed = false
  let npmConfigPath: string | undefined
  let npmConfigCreated = false
  try {
    const sha = await checkCheckout(root)
    await validateRegistryPins(root, false)
    await validateWranglerPin(root, false)
    await validateRegistryConfig(root)
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    if (!dryRun && (!accountId || !/^[a-f0-9]{32}$/i.test(accountId))) throw new Error('A valid CLOUDFLARE_ACCOUNT_ID must be configured separately; refusing to guess account')
    const worktreeParent = await realpath(tempRoot).catch(async () => {
      await mkdir(tempRoot, { recursive: true, mode: 0o700 })
      return realpath(tempRoot)
    })
    worktree = join(worktreeParent, `deploy-${sha}-${process.pid}`)
    if (inside(worktree, root)) throw new Error('Fresh detached worktree must be outside source checkout')
    await git(root, 'worktree', 'add', '--detach', worktree, sha)
    worktreeCreated = true
    await rm(join(worktree, 'out'), { recursive: true, force: true })
    const toolEnv = safeEnv()
    toolEnv.WSEFFECT_BUILD_ID = sha
    npmConfigPath = join(tempRoot, `npmrc-${sha}-${process.pid}`)
    await writeFile(npmConfigPath, `registry=${REGISTRY_URL}\n`, { mode: 0o600, flag: 'wx' })
    npmConfigCreated = true
    toolEnv.NPM_CONFIG_USERCONFIG = npmConfigPath
    toolEnv.npm_config_userconfig = npmConfigPath
    toolEnv.NPM_CONFIG_REGISTRY = REGISTRY_URL
    toolEnv.PNPM_CONFIG_USERCONFIG = npmConfigPath
    toolEnv.NPM_CONFIG_GLOBALCONFIG = npmConfigPath
    toolEnv.npm_config_globalconfig = npmConfigPath
    toolEnv.PNPM_CONFIG_GLOBALCONFIG = npmConfigPath
    toolEnv.npm_config_registry = REGISTRY_URL
    const nodeVersion = await runCommand('mise', ['exec', `node@${NODE_VERSION}`, `pnpm@${PNPM_VERSION}`, '--', 'node', '--version'], { cwd: worktree, env: toolEnv })
    if (nodeVersion !== `v${NODE_VERSION}`) throw new Error(`Pinned Node version mismatch: ${nodeVersion}`)
    const pnpmVersion = await runCommand('mise', ['exec', `node@${NODE_VERSION}`, `pnpm@${PNPM_VERSION}`, '--', 'pnpm', '--version'], { cwd: worktree, env: toolEnv })
    if (pnpmVersion !== PNPM_VERSION) throw new Error(`Pinned pnpm version mismatch: ${pnpmVersion}`)
    await runCommand('mise', ['exec', `node@${NODE_VERSION}`, `pnpm@${PNPM_VERSION}`, '--', 'pnpm', 'install', '--frozen-lockfile', `--registry=${REGISTRY_URL}`], { cwd: worktree, env: toolEnv })
    await validateRegistryPins(worktree)
    await validateWranglerPin(worktree)
    await runCommand('mise', ['exec', `node@${NODE_VERSION}`, `pnpm@${PNPM_VERSION}`, '--', 'pnpm', 'build'], { cwd: worktree, env: toolEnv })
    await runCommand('mise', ['exec', `node@${NODE_VERSION}`, `pnpm@${PNPM_VERSION}`, '--', 'pnpm', 'check'], { cwd: worktree, env: toolEnv })
    const { docsPath, markdownPath, version } = await validateOutput(worktree, sha)
    if (!dryRun) {
      snapshotAstro = join(tempRoot, `assets-${sha}-${process.pid}`)
      await captureCurrentAssets(join(worktree, 'out', '_astro'), snapshotAstro)
      snapshotCaptured = true
    }
    const retention = await mergeRetainedAssets(join(worktree, 'out'), releaseStore, sha, 3)
    const retainedPaths = retention.retainedAssets.map((asset) => asset.path)
    if (retainedPaths.length === 0) {
      const firstAsset = (await walkFiles(join(worktree, 'out', '_astro'))).find((file) => HASHED_FILENAME.test(file.split(sep).at(-1) ?? ''))
      if (!firstAsset) throw new Error('Built site has no hashed assets for production smoke validation')
      retainedPaths.push(`/_astro/${relative(join(worktree, 'out', '_astro'), firstAsset).split(sep).join('/')}`)
    }
    await inspectArtifact(join(worktree, 'out'), worktree)
    if (!dryRun) {
      const freshSha = await checkCheckout(root)
      if (freshSha !== sha) throw new Error('origin/main changed during deployment checks; refusing remote mutation')
      await validateSnapshotCompatibility(snapshotAstro!, releaseStore, sha)
      if (process.env.WSEFFECT_DEPLOY_TAKEOVER_APPROVED !== 'yes') throw new Error('Production deploy requires explicit WSEFFECT_DEPLOY_TAKEOVER_APPROVED=yes after owner-approved Worker takeover review')
      const token = await (options.readToken ?? readScopedToken)()
      if (!token || /\s/.test(token)) throw new Error('Cloudflare token lookup returned an invalid value')
      const finalSha = await checkCheckout(root)
      if (finalSha !== sha) throw new Error('origin/main changed before Wrangler deployment; refusing remote mutation')
      const deployment = options.deploy
        ? await options.deploy(worktree, sha, token, accountId!)
        : await deployWithWrangler(worktree, sha, token, accountId!, join(tempRoot, `wrangler-output-${sha}-${process.pid}.ndjson`))
      deployed = true
      if (!WORKER_VERSION_ID_PATTERN.test(deployment.workerVersionId)) throw new Error('Wrangler deployment returned an invalid Worker version identifier')
      const receiptPath = join(releaseStore, `${sha}.receipt.json`)
      const receipt: ReleaseReceipt = {
        sha,
        siteVersion: version,
        workerVersionId: deployment.workerVersionId,
        deployedAt: new Date().toISOString(),
        smoke: { status: 'pending' },
      }
      await writeReleaseReceipt(receiptPath, receipt)
      await commitRelease(snapshotAstro!, releaseStore, sha)
      try {
        await recordSmokeResult(receiptPath, receipt, () => smokeProduction({ retainedPaths, docsPath, markdownPath, expectedSha: sha }))
      } catch (error) {
        throw new Error(`Production smoke checks failed after deployment. Do not auto-rollback; inspect live state and follow the rollback/stop procedure in docs/RELEASING.md. ${(error as Error).message}`)
      }
    } else {
      console.log(`Dry-run validated ${sha} (${version}); no credential lookup or remote deployment was performed.`)
    }
  } catch (error) {
    const message = redact((error as Error).message)
    throw new Error(deployed ? `Wrangler succeeded, but a later record/smoke step failed. Do not assume production state; inspect Cloudflare and follow the rollback/stop procedure in docs/RELEASING.md. ${message}` : message)
  } finally {
    if (worktreeCreated && worktree) {
      await git(root, 'worktree', 'remove', '--force', worktree).catch(() => undefined)
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined)
    }
    if (snapshotAstro && snapshotCaptured) await rm(snapshotAstro, { recursive: true, force: true }).catch(() => undefined)
    if (npmConfigPath && npmConfigCreated) await rm(npmConfigPath, { force: true }).catch(() => undefined)
  }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeployment().catch((error: Error) => {
    console.error(redact(error.message))
    process.exitCode = 1
  })
}
