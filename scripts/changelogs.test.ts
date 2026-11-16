import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownToHtml, readInstalledChangelogs } from './changelogs.ts'

test('published Markdown changelog rendering preserves release headings, lists, and source links', () => {
  const source = 'https://github.com/wsagency/wseffect/blob/v0.1.0-rc.1/packages/app/CHANGELOG.md'
  const html = markdownToHtml('# Package\n\n## 0.1.0-rc.1\n\n- Add a `typed` API.\n- Read [the source](../README.md).', source)
  assert.match(html, /<h1>Package<\/h1>/)
  assert.match(html, /<h2>0\.1\.0-rc\.1<\/h2>/)
  assert.match(html, /<ul><li>Add a <code>typed<\/code> API\.<\/li>/)
  assert.match(html, /href="https:\/\/github\.com\/wsagency\/wseffect\/blob\/v0\.1\.0-rc\.1\/packages\/README\.md"/)
})

test('all installed public packages contribute their complete changelog content', async () => {
  const changelogs = await readInstalledChangelogs()
  assert.deepEqual(changelogs.map(({ packageName }) => packageName), [
    '@wsagency/wseffect-app',
    '@wsagency/wseffect-themes',
    '@wsagency/wseffect-foldkit',
    '@wsagency/wseffect-foldkit-ui',
    '@wsagency/wseffect-vite-plugin',
  ])
  for (const changelog of changelogs) {
    assert.equal(changelog.version, '0.1.0-rc.1')
    assert.match(changelog.markdown, /0\.1\.0-rc\.0/)
    assert.ok(changelog.html.includes('<h2>0.1.0-rc.0</h2>'))
    assert.ok(changelog.sourceUrl.endsWith('/CHANGELOG.md'))
  }
})
