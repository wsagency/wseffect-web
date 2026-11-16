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
export function normalizeMarkdownPath(route: string, markdownPath: string): string {
  assert.equal(typeof markdownPath, 'string', `${route}: Markdown path must be a string`)
  const relativePath = markdownPath.startsWith('/') ? markdownPath.slice(1) : markdownPath
  assert.ok(relativePath && relativePath.split('/').every((part) => part && part !== '.' && part !== '..'), `${route}: unsafe Markdown path`)
  const expectedPath = route === '/' ? 'index.md' : `${route.slice(1)}index.md`
  assert.equal(relativePath, expectedPath, `${route}: Markdown path does not match its canonical route`)
  return relativePath
}

function htmlForRoute(route: string): string {
  return resolve(outputRoot, route === '/' ? 'index.html' : `${route.slice(1)}index.html`)
}

function extractText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}
function markdownInlineText(value: string): string {
  const protectedValues: string[] = []
  const protect = (text: string): string => {
    const marker = `\uE000${protectedValues.length}\uE001`
    protectedValues.push(text)
    return marker
  }
  let text = value.replace(/(`+)([\s\S]*?)\1/g, (_match, _fence: string, code: string) => protect(code.replace(/\s+/g, ' ').trim()))
  text = text
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, (_match, escaped: string) => protect(escaped))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(\*\*\*|___)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(?<!\w)(\*|_)(\S(?:.*?\S)?)\1(?!\w)/g, '$2')
    .replace(/~~(\S(?:.*?\S)?)~~/g, '$1')
  return text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => protectedValues[Number(index)] ?? '').replace(/\s+/g, ' ').trim()
}
function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let codeFenceLength = 0
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '`') {
      let end = index + 1
      while (line[end] === '`') end++
      const length = end - index
      if (!codeFenceLength) codeFenceLength = length
      else if (codeFenceLength === length) codeFenceLength = 0
      cell += line.slice(index, end)
      index = end - 1
      continue
    }
    if (line[index] !== '|') {
      cell += line[index]
      continue
    }
    let backslashes = 0
    while (cell[cell.length - 1 - backslashes] === '\\') backslashes++
    if (codeFenceLength || backslashes % 2 === 1) {
      if (backslashes) cell = cell.slice(0, -1)
      cell += '|'
    } else {
      cells.push(cell.trim())
      cell = ''
    }
  }
  const trimmedLine = line.trim()
  if (trimmedLine.startsWith('|') && cells[0] === '') cells.shift()
  if (trimmedLine.endsWith('|') && cells[cells.length - 1] === '') cells.pop()
  return cells
}

function markdownTableBlocks(markdown: string): string[][][] {
  const lines = markdown.split('\n')
  const tables: string[][][] = []
  let fenceCharacter: string | undefined
  let fenceLength = 0
  for (let index = 0; index < lines.length; index++) {
    const fence = lines[index].trim().match(/^(`{3,}|~{3,})/)
    if (fence) {
      if (!fenceCharacter) {
        fenceCharacter = fence[1][0]
        fenceLength = fence[1].length
      } else if (fence[1][0] === fenceCharacter && fence[1].length >= fenceLength) {
        fenceCharacter = undefined
        fenceLength = 0
      }
      continue
    }
    if (fenceCharacter) continue
    const divider = splitMarkdownTableRow(lines[index])
    if (!lines[index].includes('|') || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    if (index === 0 || !lines[index - 1].includes('|')) continue
    const rows = [splitMarkdownTableRow(lines[index - 1])]
    let row = index + 1
    while (row < lines.length && lines[row].trim() && lines[row].includes('|')) {
      const cells = splitMarkdownTableRow(lines[row])
      if (cells.length !== divider.length) break
      rows.push(cells)
      row++
    }
    tables.push(rows)
    index = row - 1
  }
  return tables
}
function visibleTableCells(table: Element): string[] {
  const cells: string[] = []
  const rows = table.getElementsByTagName('tr')
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (row.getAttribute('aria-hidden') === 'true') continue
    let parent = row.parentElement
    while (parent && parent.nodeName !== 'TABLE') parent = parent.parentElement
    if (parent !== table) continue
    for (let childIndex = 0; childIndex < row.childNodes.length; childIndex++) {
      const child = row.childNodes[childIndex]
      if (child?.nodeType === 1 && (child.nodeName === 'TH' || child.nodeName === 'TD')) cells.push(extractText(child as Element))
    }
  }
  return cells
}


export function assertMarkdownSemantics(route: string, html: string, markdown: string): void {
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
  const markdownTables = markdownTableBlocks(markdown)
  const tables = [...main.querySelectorAll('table')]
  assert.equal(markdownTables.length, tables.length, `${route}: Markdown table count differs from HTML`)
  for (const [index, table] of tables.entries()) {
    const markdownCells = markdownTables[index].flat()
    const cells = visibleTableCells(table)
    assert.equal(markdownCells.length, cells.length, `${route}: table cell count differs from HTML`)
    for (const [cellIndex, cell] of cells.entries()) {
      assert.equal(markdownInlineText(markdownCells[cellIndex]), cell, `${route}: table cell differs from Markdown: ${cell}`)
    }
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
    assert.ok(Object.hasOwn(routeMap, page.route), `${page.route}: Worker route map entry is missing`)
    const mappedMarkdownPath = normalizeMarkdownPath(page.route, routeMap[page.route])
    const manifestMarkdownPath = normalizeMarkdownPath(page.route, page.markdownPath)
    assert.equal(mappedMarkdownPath, manifestMarkdownPath, `${page.route}: Worker Markdown path differs from pages manifest`)
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
    const markdown = await readFile(resolve(outputRoot, manifestMarkdownPath), 'utf8')
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
  const changelogMarkdownPath = normalizeMarkdownPath('/changelog/', routeMap['/changelog/'])
  const changelogTwin = await readFile(resolve(outputRoot, changelogMarkdownPath), 'utf8')
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
  console.log(`Checked ${pages.length} pages, ${inventory.length} exports, and ${apiReferences.length} API declaration sections.`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await checkSiteLinks()
