import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const packageNames = [
  '@wsagency/wseffect-app',
  '@wsagency/wseffect-themes',
  '@wsagency/wseffect-foldkit',
  '@wsagency/wseffect-foldkit-ui',
  '@wsagency/wseffect-vite-plugin',
] as const

type Manifest = Readonly<{
  name: string
  version: string
  repository?: string | { url?: string; directory?: string }
}>
export type PackageChangelog = Readonly<{ packageName: string; version: string; sourceUrl: string; markdown: string; html: string }>

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inlineMarkdown(value: string, sourceUrl: string): string {
  const tokens: string[] = []
  const tokenized = value.replace(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g, (match, code: string | undefined, label: string | undefined, rawHref: string | undefined, strongA: string | undefined, strongB: string | undefined, emphasisA: string | undefined, emphasisB: string | undefined) => {
    let html: string
    if (code !== undefined) html = `<code>${escapeHtml(code)}</code>`
    else if (label !== undefined && rawHref !== undefined) {
      const href = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(rawHref) ? rawHref : new URL(rawHref, sourceUrl).href
      html = `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    } else if (strongA !== undefined || strongB !== undefined) html = `<strong>${escapeHtml(strongA ?? strongB ?? '')}</strong>`
    else html = `<em>${escapeHtml(emphasisA ?? emphasisB ?? '')}</em>`
    const marker = `\uE000${tokens.length}\uE001`
    tokens.push(html)
    return marker
  })
  let result = escapeHtml(tokenized)
  for (let index = 0; index < tokens.length; index++) result = result.replace(`\uE000${index}\uE001`, tokens[index])
  return result
}

function isBlockStart(line: string): boolean {
  return /^(?:#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s?|```|~~~|\s*[-*_]{3,}\s*)/.test(line)
}

export function markdownToHtml(markdown: string, sourceUrl: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim()
    if (!line) { index++; continue }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (heading) {
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2], sourceUrl)}</h${level}>`)
      index++
      continue
    }
    if (/^```|^~~~/.test(line)) {
      const language = line.slice(3).trim().split(/\s+/)[0]
      const fence = line.slice(0, 3)
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence)) code.push(lines[index++])
      if (index >= lines.length) throw new Error('Unclosed fenced code block in published CHANGELOG.md')
      index++
      output.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    if (/^[-*_]{3,}$/.test(line)) { output.push('<hr />'); index++; continue }
    const listItem = line.match(/^(?:[-*+]\s+|\d+\.\s+)/)
    if (listItem) {
      const ordered = /^\d+\./.test(line)
      const tag = ordered ? 'ol' : 'ul'
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index].trim()
        if (!(ordered ? /^\d+\.\s+/ : /^[-*+]\s+/).test(item)) break
        items.push(`<li>${inlineMarkdown(item.replace(/^(?:[-*+]\s+|\d+\.\s+)/, ''), sourceUrl)}</li>`)
        index++
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }
    if (line.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('>')) quote.push(inlineMarkdown(lines[index++].trim().replace(/^>\s?/, ''), sourceUrl))
      output.push(`<blockquote><p>${quote.join(' ')}</p></blockquote>`)
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index].trim())) paragraph.push(lines[index++].trim())
    output.push(`<p>${paragraph.map((part) => inlineMarkdown(part, sourceUrl)).join(' ')}</p>`)
  }
  return output.join('\n')
}

function repositoryUrl(manifest: Manifest): string {
  const value = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const url = value?.replace(/^git\+/, '').replace(/\.git$/, '')
  if (!url) throw new Error(`${manifest.name}: package repository URL is missing`)
  return url
}

async function findSiteRoot(): Promise<string> {
  let directory = resolve(process.cwd())
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name === 'wseffect-web') return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Could not find the wseffect-web project root from ${process.cwd()}`)
    directory = parent
  }
}

export async function readInstalledChangelogs(): Promise<ReadonlyArray<PackageChangelog>> {
  const siteRoot = await findSiteRoot()
  const changelogs: PackageChangelog[] = []
  for (const packageName of packageNames) {
    const packageRoot = resolve(siteRoot, 'node_modules', ...packageName.split('/'))
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Manifest
    if (manifest.name !== packageName) throw new Error(`${packageName}: installed package metadata name mismatch`)
    const markdown = await readFile(join(packageRoot, 'CHANGELOG.md'), 'utf8')
    if (!markdown.trim()) throw new Error(`${packageName}: published CHANGELOG.md is empty`)
    const repository = repositoryUrl(manifest)
    const directory = typeof manifest.repository === 'object' ? manifest.repository.directory : undefined
    const sourceUrl = `${repository}/blob/v${manifest.version}/${directory ? `${directory}/` : ''}CHANGELOG.md`
    changelogs.push({ packageName, version: manifest.version, sourceUrl, markdown, html: markdownToHtml(markdown, sourceUrl) })
  }
  return changelogs
}
