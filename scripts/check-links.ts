import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { validateRouteAssignments, type InventoryEntry } from './inventory.ts'
import type { ApiReference } from './api-reference.ts'
import { markdownToHtml, readInstalledChangelogs } from './changelogs.ts'

type PageRecord = Readonly<{ route: string; title: string; description: string; canonical: string; markdownPath: string }>
const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const outputRoot = resolve(siteRoot, 'out')
const siteUrl = 'https://wseffect.com'

function routeForLocalPath(pathname: string): string {
  if (pathname.endsWith('.md')) {
    return pathname === '/index.md' ? '/' : pathname.replace(/\/index\.md$/, '/')
  }
  if (pathname === '/') return '/'
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

function htmlForRoute(route: string): string {
  return resolve(outputRoot, route === '/' ? 'index.html' : `${route.slice(1)}index.html`)
}

function extractText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}
function markdownInlineText(value: string): string {
  return value.replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/[*_~]/g, '').trim()
}

function assertMarkdownSemantics(route: string, html: string, markdown: string): void {
  const { document } = parseHTML(html)
  const main = document.querySelector('main#main-content')
  assert.ok(main, `${route}: missing main content region`)
  for (const heading of main.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = extractText(heading)
    assert.ok(markdown.split('\n').some((line) => /^#{1,6}\s/.test(line) && markdownInlineText(line.replace(/^#{1,6}\s+/, '')) === text), `${route}: heading omitted from Markdown: ${text}`)
  }
  for (const link of main.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')
    if (href && !markdown.includes(`](${href})`)) assert.fail(`${route}: link omitted from Markdown: ${href}`)
  }
  for (const pre of main.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    const classes = `${pre.getAttribute('class') ?? ''} ${code?.getAttribute('class') ?? ''}`
    const lang = pre.getAttribute('data-language') ?? code?.getAttribute('data-language') ?? classes.match(/(?:language|lang)-([\w+-]+)/)?.[1]
    if (lang) assert.ok(markdown.includes(`\`\`\`${lang}`), `${route}: code language ${lang} omitted from Markdown`)
    const text = (code?.textContent ?? pre.textContent ?? '').trim()
    if (text) assert.ok(markdown.includes(text), `${route}: code block omitted from Markdown`)
  }
  for (const table of main.querySelectorAll('table')) {
    const cells = [...table.querySelectorAll('th, td')].map(extractText).filter(Boolean)
    assert.ok(markdown.split('\n').some((line) => line.includes('|')), `${route}: table omitted from Markdown`)
    for (const cell of cells) assert.ok(markdown.includes(cell), `${route}: table cell omitted from Markdown: ${cell}`)
  }
}

async function assertLocalLink(fromRoute: string, href: string, routes: ReadonlySet<string>, anchors: ReadonlyMap<string, Set<string>>): Promise<void> {
  let url: URL
  try { url = new URL(href, `${siteUrl}${fromRoute}`) } catch { assert.fail(`${fromRoute}: invalid local link ${href}`) }
  if (url.origin !== siteUrl) return
  const pathname = decodeURIComponent(url.pathname)
  const route = routeForLocalPath(pathname)
  const markdown = pathname.endsWith('.md')
  const fileName = pathname.slice(pathname.lastIndexOf('/') + 1)
  const staticFile = !pathname.endsWith('/') && fileName.includes('.')
  if (markdown || staticFile) {
    const target = resolve(outputRoot, `.${pathname}`)
    assert.ok(target.startsWith(`${outputRoot}${sep}`), `${fromRoute}: unsafe local link ${href}`)
    await access(target)
  } else {
    assert.ok(routes.has(route), `${fromRoute}: local route does not exist: ${href}`)
  }
  if (url.hash) {
    const targetRoute = staticFile ? fromRoute : route
    const ids = anchors.get(targetRoute)
    assert.ok(ids?.has(decodeURIComponent(url.hash.slice(1))), `${fromRoute}: missing anchor ${url.hash} in ${targetRoute}`)
  }
}

export async function checkSiteLinks(): Promise<void> {
  const inventory = JSON.parse(await readFile(resolve(siteRoot, 'src/data/export-inventory.json'), 'utf8')) as InventoryEntry[]
  validateRouteAssignments(inventory.map(({ route, anchor }) => ({ route, anchor })))
  const apiReferences = JSON.parse(await readFile(resolve(siteRoot, 'generated/api-reference.json'), 'utf8')) as ApiReference[]
  assert.equal(apiReferences.length, inventory.filter((entry) => entry.kind === 'api').length, 'API generator must cover every API inventory export')
  const pages = JSON.parse(await readFile(resolve(siteRoot, 'generated/pages.json'), 'utf8')) as PageRecord[]
  const routeMap = JSON.parse(await readFile(resolve(siteRoot, 'generated/routes.json'), 'utf8')) as Record<string, string>
  const routes = new Set(pages.map((page) => page.route))
  assert.equal(Object.keys(routeMap).length, pages.length, 'Worker route map must cover every discovered page exactly once')
  const anchors = new Map<string, Set<string>>()
  const pageHtml = new Map<string, string>()
  for (const page of pages) {
    assert.equal(routeMap[page.route], page.markdownPath, `${page.route}: Worker Markdown path differs from pages manifest`)
    assert.equal(page.canonical, `${siteUrl}${page.route}`, `${page.route}: canonical URL mismatch`)
    const htmlPath = htmlForRoute(page.route)
    const html = await readFile(htmlPath, 'utf8')
    const { document } = parseHTML(html)
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href')
    assert.equal(canonical, page.canonical, `${page.route}: built HTML canonical differs from manifest`)
    const bodyIds = new Set([...document.querySelectorAll('[id]')].map((element) => element.getAttribute('id')!).filter(Boolean))
    for (const named of document.querySelectorAll('[name]')) bodyIds.add(named.getAttribute('name')!)
    anchors.set(page.route, bodyIds)
    pageHtml.set(page.route, html)
    const markdown = await readFile(resolve(outputRoot, `.${page.markdownPath}`), 'utf8')
    assertMarkdownSemantics(page.route, html, markdown)
  }
  assert.ok(!routes.has('/404/'), '404 page must not be included in the published route manifest')
  const propsByExport = JSON.parse(await readFile(resolve(siteRoot, 'generated/props.json'), 'utf8')) as Record<string, Array<{ schemaName: string; rows: Array<{ name: string }> }>>
  for (const [exportPath, schemas] of Object.entries(propsByExport)) {
    const entry = inventory.find((item) => item.packageName === '@wsagency/wseffect-themes' && item.exportPath === exportPath && item.kind === 'api')
    assert.ok(entry, `Generated Props schemas have no Themes API export: ${exportPath}`)
    const html = pageHtml.get(entry.route)!
    for (const schema of schemas) {
      const sourceExport = `@wsagency/wseffect-themes${exportPath === '.' ? '' : exportPath.slice(1)} · ${schema.schemaName}`
      assert.ok(html.includes(sourceExport), `${exportPath}: Props table missing for ${schema.schemaName}`)
      for (const row of schema.rows) assert.ok(html.includes(row.name), `${exportPath}: Props table missing property ${row.name}`)
    }
  }
  for (const entry of inventory) {
    assert.ok(routes.has(entry.route), `${entry.packageName}${entry.exportPath}: inventory route is unmapped: ${entry.route}`)
    const document = parseHTML(pageHtml.get(entry.route)!).document
    if (entry.anchor) {
      const matchingIds = [...document.querySelectorAll('[id]')].filter((element) => element.getAttribute('id') === entry.anchor)
      assert.equal(matchingIds.length, 1, `${entry.packageName}${entry.exportPath}: expected exactly one inventory anchor #${entry.anchor}`)
    }
    const sourceLink = [...document.querySelectorAll('a[href]')].find((link) => link.getAttribute('href') === entry.sourceUrl)
    assert.ok(sourceLink, `${entry.packageName}${entry.exportPath}: source URL is missing from its generated section`)
    if (entry.kind === 'api') {
      const section = sourceLink.closest('.api-reference')
      assert.ok(section?.querySelector('h2'), `${entry.packageName}${entry.exportPath}: API section is missing`)
      assert.ok(section?.querySelector('pre code.language-ts'), `${entry.packageName}${entry.exportPath}: declaration or import example is missing`)
    } else if (entry.kind === 'style') {
      const section = sourceLink.closest('.api-reference')
      assert.ok(section?.querySelector('pre code.language-ts'), `${entry.packageName}${entry.exportPath}: stylesheet import example is missing`)
    }
  }
  const componentEntries = inventory.filter((entry) =>
    entry.packageName === '@wsagency/wseffect-themes'
    && entry.kind === 'api'
    && entry.exportPath.startsWith('./components/')
  )
  assert.ok(routes.has('/themes/components/'), 'Themes component index route is missing')
  const componentIndex = parseHTML(pageHtml.get('/themes/components/')!).document
  for (const component of componentEntries) {
    const href = `${component.route}${component.anchor ? `#${component.anchor}` : ''}`
    assert.ok([...componentIndex.querySelectorAll('a[href]')].some((link) => link.getAttribute('href') === href), `Themes component index omits ${component.exportPath}`)
  }
  const changelogs = await readInstalledChangelogs()
  const changelogHtml = pageHtml.get('/changelog/')
  assert.ok(changelogHtml, 'Generated package changelog route is missing')
  const changelogDocument = parseHTML(changelogHtml).document
  const changelogTwin = await readFile(resolve(outputRoot, routeMap['/changelog/']), 'utf8')
  const changelogTwinText = parseHTML(markdownToHtml(changelogTwin, `${siteUrl}/changelog/`)).document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  for (const history of changelogs) {
    const sectionId = `changelog-${history.packageName.replaceAll('@', '').replaceAll('/', '-')}`
    const section = changelogDocument.getElementById(sectionId)
    assert.ok(section, `${history.packageName}: full published changelog section is missing`)
    assert.ok([...section.querySelectorAll('a[href]')].some((link) => link.getAttribute('href') === history.sourceUrl), `${history.packageName}: changelog source link is missing`)
    const expected = parseHTML(history.html).document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    assert.ok(section.textContent?.replace(/\s+/g, ' ').trim().includes(expected), `${history.packageName}: published changelog content was truncated`)
    assert.ok(changelogTwinText.includes(expected), `${history.packageName}: Markdown twin omits published changelog content`)
  }
  for (const page of pages) {
    const { document } = parseHTML(pageHtml.get(page.route)!)
    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href')
      if (href && !/^(?:https?:|mailto:|tel:|javascript:|data:|\/\/)/i.test(href)) await assertLocalLink(page.route, href, routes, anchors)
      else if (href?.startsWith('//')) continue
    }
  }
  const searchHtml = pageHtml.get('/search/')
  assert.ok(searchHtml?.includes('/pagefind/pagefind-ui.js') && searchHtml.includes('PagefindUI'), 'Search route must load the Pagefind UI runtime')
  await access(resolve(outputRoot, 'pagefind/pagefind-ui.js'))
  await access(resolve(outputRoot, 'pagefind/pagefind-ui.css'))
  const robots = await readFile(resolve(outputRoot, 'robots.txt'), 'utf8')
  assert.match(robots, /User-agent:\s*\*\s*\nAllow:\s*\//)
  assert.match(robots, new RegExp(`Sitemap: ${siteUrl.replaceAll('.', '\\.')}/sitemap\\.xml`))
  const sitemap = await readFile(resolve(outputRoot, 'sitemap.xml'), 'utf8')
  for (const page of pages) assert.ok(sitemap.includes(`<loc>${page.canonical}</loc>`), `Sitemap omits ${page.route}`)
  console.log(`Checked ${pages.length} pages, ${inventory.length} exports, and ${apiEntries.length} API declaration sections.`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await checkSiteLinks()
