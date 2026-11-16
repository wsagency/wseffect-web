import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlToMarkdown } from './markdown.ts'

test('Markdown twins preserve headings, links, tables, and language-tagged code', () => {
  const html = `<html><body><header>site header</header><main id="main-content">
    <h1>Guide title</h1><p>Read <a href="/next/">the next guide</a>.</p>
    <pre><code class="language-ts">const answer: number = 42</code></pre>
    <table><thead><tr><th>Name</th><th>Required</th></tr></thead><tbody><tr><td>value</td><td>Yes <a href="/props/">options</a> <code>string</code></td></tr></tbody></table>
    <nav><a href="/themes/">Component navigation</a></nav></main><nav>navigation chrome</nav><footer>footer chrome</footer></body></html>`
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^# Guide title$/m)
  assert.match(markdown, /\[the next guide\]\(\/next\/\)/)
  assert.match(markdown, /```ts\nconst answer: number = 42\n```/)
  assert.ok(markdown.includes('[options](/props/)'))
  assert.ok(markdown.includes('`string`'))
  assert.ok(markdown.includes('[Component navigation](/themes/)'))
  assert.doesNotMatch(markdown, /site header|navigation chrome|footer chrome/)
})

test('Markdown conversion uses the authored main region rather than site chrome', () => {
  const markdown = htmlToMarkdown(`<header>chrome</header><main id="main-content"><p>Authored copy.</p><p data-pagefind-ignore="all">Search route copy.</p><script>bad()</script><style>.x{}</style></main><footer>chrome</footer>`)
  assert.ok(markdown.includes('Authored copy.') && markdown.includes('Search route copy.'))
})
