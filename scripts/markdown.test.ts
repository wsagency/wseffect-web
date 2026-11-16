import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlToMarkdown } from './markdown.ts'

test('Markdown twins preserve headings, links, tables, and language-tagged code', () => {
  const html = `<html><body><header>site header</header><main id="main-content">
    <h1>Guide title</h1><p>Read <a href="/next/">the next guide</a>.</p>
    <pre><code class="language-ts">const answer: number = 42</code></pre>
    <table><thead><tr><th>Name</th><th>Required</th></tr></thead><tbody><tr><td>value</td><td>Yes</td></tr></tbody></table>
    <nav>navigation chrome</nav></main><footer>footer chrome</footer></body></html>`
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^# Guide title$/m)
  assert.match(markdown, /\[the next guide\]\(\/next\/\)/)
  assert.match(markdown, /```ts\nconst answer: number = 42\n```/)
  assert.match(markdown, /Name \| Required\n--- \| ---\nvalue \| Yes/)
  assert.doesNotMatch(markdown, /site header|navigation chrome|footer chrome/)
})

test('Markdown conversion uses the authored main region rather than site chrome', () => {
  const markdown = htmlToMarkdown(`<header>chrome</header><main id="main-content"><p>Authored copy.</p><p data-pagefind-ignore="all">Search route copy.</p><script>bad()</script><style>.x{}</style></main><footer>chrome</footer>`)
  assert.ok(markdown.includes('Authored copy.') && markdown.includes('Search route copy.'))
})
