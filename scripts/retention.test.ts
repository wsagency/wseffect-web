import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { mergeRetainedAssets } from './retention.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wseffect-retention-'));
  roots.push(root);
  const out = join(root, 'out');
  const store = join(root, 'release-store');
  await mkdir(join(out, '_astro'), { recursive: true });
  await mkdir(store, { recursive: true });
  return { root, out, store };
}

async function addRelease(store: string, sourceSha: string, assetName: string, bytes: string) {
  const assetDir = join(store, sourceSha, '_astro');
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, assetName), bytes);
}

async function setOrder(store: string, releases: string[]) {
  await writeFile(join(store, 'releases.json'), JSON.stringify({ releases }));
}

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('retains current plus previous three releases in manifest order', async () => {
  const { out, store } = await fixture();
  const releases = [sha(4), sha(3), sha(2), sha(1), sha(0)];
  await setOrder(store, releases);
  for (let i = 0; i < releases.length; i++) {
    await addRelease(store, releases[i]!, `chunk.${String(i).padStart(8, '0')}.js`, `asset-${i}`);
  }
  await writeFile(join(out, '_astro', 'current.12345678.js'), 'current');
  await writeFile(join(out, 'unrelated.txt'), 'keep');

  const result = await mergeRetainedAssets(out, store, releases[0]!);
  assert.deepEqual(result.releases, releases.slice(0, 4));
  assert.deepEqual(result.retainedAssets.map(({ sourceSha }) => sourceSha), [releases[1], releases[2], releases[3]]);
  assert.equal(result.assetCount, 5);
  assert.equal(await readFile(join(out, '_astro', 'chunk.00000001.js'), 'utf8'), 'asset-1');
  await assert.rejects(readFile(join(out, '_astro', 'chunk.00000004.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(out, 'unrelated.txt'), 'utf8'), 'keep');
});

test('refuses differing-byte collisions before mutating output', async () => {
  const { out, store } = await fixture();
  const old = sha(1);
  await setOrder(store, [old]);
  await addRelease(store, old, 'shared.abcdefgh.js', 'retained-bytes');
  await writeFile(join(store, old, '_astro', 'new.abcdefgh.js'), 'new-asset');
  await writeFile(join(out, '_astro', 'shared.abcdefgh.js'), 'current-bytes');
  await assert.rejects(mergeRetainedAssets(out, store, sha(2)), /collision with different bytes/);
  await assert.rejects(readFile(join(out, '_astro', 'new.abcdefgh.js')), { code: 'ENOENT' });
});

test('enforces configured file-count and individual-size limits before mutation', async () => {
  const { out, store } = await fixture();
  const old = sha(1);
  await setOrder(store, [old]);
  await addRelease(store, old, 'old.abcdefgh.js', '12345');

  await assert.rejects(
    mergeRetainedAssets(out, store, sha(2), 3, { maxFiles: 0, maxFileBytes: 100 }),
    /file count/,
  );
  await assert.rejects(readFile(join(out, '_astro', 'old.abcdefgh.js')), { code: 'ENOENT' });
  await assert.rejects(
    mergeRetainedAssets(out, store, sha(2), 3, { maxFiles: 10, maxFileBytes: 4 }),
    /per-file limit/,
  );
  await assert.rejects(readFile(join(out, '_astro', 'old.abcdefgh.js')), { code: 'ENOENT' });
});

test('rejects symlinks in release trees without following them', async () => {
  const { out, store, root } = await fixture();
  const old = sha(1);
  await setOrder(store, [old]);
  await addRelease(store, old, 'valid.abcdefgh.js', 'valid');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'escape.abcdefgh.js'), 'outside');
  await symlink(outside, join(store, old, 'linked'));
  await assert.rejects(mergeRetainedAssets(out, store, sha(2)), /Symlink is not permitted/);
  await assert.rejects(readFile(join(out, '_astro', 'valid.abcdefgh.js')), { code: 'ENOENT' });
});

test('returns deterministic per-asset source SHA provenance', async () => {
  const { out, store } = await fixture();
  const releases = [sha(3), sha(2), sha(1)];
  await setOrder(store, releases);
  await addRelease(store, releases[1]!, 'a.abcdefgh.js', 'a');
  await addRelease(store, releases[1]!, 'b.abcdefgh.js', 'b');
  await addRelease(store, releases[2]!, 'c.abcdefgh.js', 'c');
  const result = await mergeRetainedAssets(out, store, releases[0]!);
  assert.deepEqual(result.releases, releases);
  assert.deepEqual(result.retainedAssets, [
    { path: '/_astro/a.abcdefgh.js', sourceSha: releases[1] },
    { path: '/_astro/b.abcdefgh.js', sourceSha: releases[1] },
    { path: '/_astro/c.abcdefgh.js', sourceSha: releases[2] },
  ]);
});
