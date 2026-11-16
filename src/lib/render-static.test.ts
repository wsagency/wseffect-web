import assert from 'node:assert/strict'
import test from 'node:test'
import { renderStatic, renderThemeShell } from './render-static.ts'

test('serializes static Foldkit markup without hydration markers', () => {
  const html = renderStatic((h) => h.button([h.Type('button'), h.AriaLabel('Save changes')], ['Save']))
  assert.match(html, /<button[^>]*aria-label="Save changes"[^>]*>Save<\/button>/)
  assert.doesNotMatch(html, /data-foldkit-(?:app|flags)|<script/i)
})

test('preserves accessible component output', () => {
  const html = renderStatic((h) => h.label([h.For('email')], ['Email', h.input([h.Id('email'), h.Type('email')])]))
  assert.match(html, /<label[^>]*for="email"[^>]*>/)
  assert.match(html, /<input[^>]*id="email"[^>]*>/)
})

test('uses actual Theme output around one replaceable slot', () => {
  const { before, after } = renderThemeShell({ appearance: 'light' })
  assert.match(before, /data-is-root-theme="true"/)
  assert.ok(after.length > 0)
  assert.doesNotMatch(`${before}${after}`, /wseffect-static-theme-slot/)
  const root = `${before}${after}`
  assert.equal((root.match(/id="foldkit-portal-root"/g) ?? []).length, 1)
})

test('static rendering errors propagate instead of returning placeholder markup', () => {
  assert.throws(() => renderStatic(() => { throw new Error('view failed') }), /view failed/)
})

