import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertMarkdownSemantics, normalizeMarkdownPath } from './check-links.ts'
import { htmlToMarkdown } from './markdown.ts'

test('Markdown paths normalize relative and site-rooted manifest forms', () => {
  assert.equal(normalizeMarkdownPath('/app/breakpoints/', 'app/breakpoints/index.md'), 'app/breakpoints/index.md')
  assert.equal(normalizeMarkdownPath('/app/breakpoints/', '/app/breakpoints/index.md'), 'app/breakpoints/index.md')
  assert.equal(normalizeMarkdownPath('/', '/index.md'), 'index.md')
})

test('Markdown path normalization rejects paths that do not map safely to their route', () => {
  assert.throws(() => normalizeMarkdownPath('/app/breakpoints/', '../app/breakpoints/index.md'))
  assert.throws(() => normalizeMarkdownPath('/app/breakpoints/', '/other/index.md'))
  assert.throws(() => normalizeMarkdownPath('/app/breakpoints/', '/app\\breakpoints\\index.md'))
})
test('table semantics compare cell text independently of inline Markdown markup', () => {
  const html = '<main id="main-content"><table><thead><tr><th>Request</th><th>Required behavior</th></tr></thead><tbody><tr><td><code>/assets/*</code></td><td>Fingerprinted files: <code>public, max-age=31536000, immutable</code>; missing file is 404, never app HTML.</td></tr></tbody></table></main>'
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^\| Request \| Required behavior \|$/m)
  assert.match(markdown, /`public, max-age=31536000, immutable`/)
  assert.doesNotThrow(() => assertMarkdownSemantics('/app/deployment-contract/', html, markdown))
})
test('heading semantics preserve underscores inside inline code spans', () => {
  const html = '<main id="main-content"><h4><code>BUILD_ID</code></h4></main>'
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^#### `BUILD_ID`$/m)
  assert.doesNotThrow(() => assertMarkdownSemantics('/app/', html, markdown))
})
test('Markdown conversion preserves no-JavaScript fallback links', () => {
  const html = '<main id="main-content"><noscript><p>Search requires JavaScript. Browse the <a href="/getting-started/">documentation index</a>.</p></noscript></main>'
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /\[documentation index\]\(\/getting-started\/\)/)
  assert.doesNotThrow(() => assertMarkdownSemantics('/search/', html, markdown))
})
test('table parsing preserves escaped pipes and angle brackets in code cells', () => {
  const html = '<main id="main-content"><table><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody><tr><td><code>size</code></td><td><code>"1" | "2" | Responsive&lt;"1" | "2"&gt;</code></td></tr></tbody></table></main>'
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /Responsive</)
  assert.doesNotThrow(() => assertMarkdownSemantics('/themes/components/avatar/', html, markdown))
})
test('table conversion keeps header button text and omits aria-hidden spacer rows', () => {
  const html = '<main id="main-content"><table><thead><tr><th><input aria-label="Select all visible rows" type="checkbox"></th><th><button type="button"><span>Name</span></button></th></tr></thead><tbody><tr aria-hidden="true"><td colspan="2"></td></tr><tr><td><input aria-label="Select row jordan" type="checkbox"></td><td>Jordan Doe</td></tr></tbody></table></main>'
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /Name/)
  assert.doesNotThrow(() => assertMarkdownSemantics('/themes/components/data-table/', html, markdown))
})
test('single-column HTML tables remain Markdown tables', () => {
  const html = '<main id="main-content"><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Jordan Doe</td></tr></tbody></table></main>'
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^\| Name \|$/m)
  assert.doesNotThrow(() => assertMarkdownSemantics('/themes/components/table/', html, markdown))
})
