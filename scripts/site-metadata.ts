import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { htmlToMarkdown } from './markdown.ts'
import { parseHTML } from 'linkedom'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const outputRoot = join(siteRoot, 'out')
const generatedRoot = join(siteRoot, 'generated')
const SITE_URL = 'https://wseffect.com'
type PageMetadata = Readonly<{ route: string; title: string; description: string; canonical: string; markdownPath: string }>

async function htmlFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await htmlFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(path)
  }
  return files
}

function routeFromHtml(file: string): string | undefined {
  const relativeFile = relative(outputRoot, file).split(sep).join('/')
  if (relativeFile === '404.html' || relativeFile === '404/index.html' || relativeFile.endsWith('/404.html')) return undefined
  if (relativeFile === 'index.html') return '/'
  if (relativeFile.endsWith('/index.html')) return `/${relativeFile.slice(0, -'index.html'.length)}`
  if (relativeFile.endsWith('.html')) return `/${relativeFile.slice(0, -'.html'.length)}/`
  return undefined
}

function metadataFromHtml(route: string, html: string): PageMetadata {
  const { document } = parseHTML(html)
  const title = document.querySelector('title')?.textContent?.trim()
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href')
  if (!title || !description || !canonical) throw new Error(`${route}: missing title, description, or canonical URL`)
  const expected = `${SITE_URL}${route}`
  if (canonical !== expected) throw new Error(`${route}: canonical is ${canonical}, expected ${expected}`)
  const markdownPath = route === '/' ? '/index.md' : `${route.slice(1, -1)}/index.md`
  return { route, title, description, canonical, markdownPath }
}

function builtSha(): string {
  const supplied = [
    process.env.WSEFFECT_BUILD_ID,
    process.env.SOURCE_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
    process.env.GITHUB_SHA,
  ].filter((value): value is string => Boolean(value))
  for (const sha of supplied) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw new Error(`Invalid build SHA: ${JSON.stringify(sha)}`)
  }
  if (new Set(supplied.map((sha) => sha.toLowerCase())).size > 1) {
    throw new Error(`Conflicting build SHA environment variables: ${supplied.join(', ')}`)
  }
  let sha = supplied[0]
  if (!sha) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Cannot determine the built git SHA: ${result.stderr || result.error?.message || 'git rev-parse failed'}`)
    sha = result.stdout.trim()
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw new Error(`Invalid build SHA: ${JSON.stringify(sha)}`)
  return sha.toLowerCase()
}

export async function generateSiteMetadata(): Promise<ReadonlyArray<PageMetadata>> {
  await mkdir(generatedRoot, { recursive: true })
  const pages: PageMetadata[] = []
  for (const file of (await htmlFiles(outputRoot)).sort()) {
    const route = routeFromHtml(file)
    if (!route) continue
    const html = await readFile(file, 'utf8')
    const metadata = metadataFromHtml(route, html)
    const markdown = htmlToMarkdown(html)
    if (!markdown.trim()) throw new Error(`${route}: prose Markdown twin is empty`)
    const markdownFile = join(outputRoot, metadata.markdownPath)
    await mkdir(dirname(markdownFile), { recursive: true })
    await writeFile(markdownFile, markdown)
    pages.push(metadata)
  }
  if (!pages.some((page) => page.route === '/')) throw new Error('Built site is missing its home page')
  await writeFile(join(generatedRoot, 'pages.json'), `${JSON.stringify(pages, null, 2)}\n`)
  const routeMap = Object.fromEntries(pages.map(({ route, markdownPath }) => [route, markdownPath]))
  await writeFile(join(generatedRoot, 'routes.json'), `${JSON.stringify(routeMap, null, 2)}\n`)
  const packageJson = JSON.parse(await readFile(join(siteRoot, 'package.json'), 'utf8')) as { version: string }
  await writeFile(join(outputRoot, 'version.json'), `${JSON.stringify({ version: packageJson.version, sha: builtSha() }, null, 2)}\n`)
  await writeFile(join(outputRoot, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`)
  const sitemap = pages.map((page) => `  <url><loc>${page.canonical}</loc></url>`).join('\n')
  await writeFile(join(outputRoot, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap}\n</urlset>\n`)
  return pages
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pages = await generateSiteMetadata()
  console.log(`Generated metadata and Markdown twins for ${pages.length} canonical pages.`)
}
