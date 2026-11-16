import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildStarters } from './starters.ts'

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('builds deterministic downloadable archives with complete independent projects', async () => {
  const results = await buildStarters(siteRoot)
  assert.deepEqual(results.map(({ id }) => id), ['minimal', 'full'])
  for (const { id, href, sha256 } of results) {
    assert.equal(href, `/starters/wseffect-${id}-0.1.0-rc.1.tgz`)
    assert.match(sha256, /^[a-f0-9]{64}$/)
  }
  const firstMinimal = await readFile(join(siteRoot, 'public/starters/wseffect-minimal-0.1.0-rc.1.tgz'))
  const firstFull = await readFile(join(siteRoot, 'public/starters/wseffect-full-0.1.0-rc.1.tgz'))
  const again = await buildStarters(siteRoot)
  assert.deepEqual(firstMinimal, await readFile(join(siteRoot, 'public/starters/wseffect-minimal-0.1.0-rc.1.tgz')))
  assert.deepEqual(firstFull, await readFile(join(siteRoot, 'public/starters/wseffect-full-0.1.0-rc.1.tgz')))
  assert.deepEqual(results, again)
})

test('starter dependency declarations exclude local dependency protocols', async () => {
  const root = new URL('../src/starters/', import.meta.url)
  for (const id of ['minimal', 'full']) {
    const manifest = JSON.parse(await readFile(new URL(`${id}/package.json`, root), 'utf8'))
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const [name, version] of Object.entries(deps)) {
      assert.equal(typeof version, 'string', `${id}: ${name} version must be a string`)
      assert.doesNotMatch(version as string, /^(?:workspace:|link:|file:|git\+|https?:)/, `${id}: ${name} must resolve from registry`)
    }
  }
})
