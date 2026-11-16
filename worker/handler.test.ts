import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker, type AssetBinding } from './handler.ts';

const fixtures: Readonly<Record<string, { body: string; type: string }>> = {
  '/index.html': { body: '<!doctype html><title>fixture-root</title>', type: 'text/html; charset=utf-8' },
  '/guide/index.html': { body: '<!doctype html><title>fixture-guide</title>', type: 'text/html; charset=utf-8' },
  '/guide/index.md': { body: '# fixture-guide', type: 'text/markdown; charset=utf-8' },
  '/robots.txt': { body: 'User-agent: *', type: 'text/plain; charset=utf-8' },
  '/sitemap-index.xml': { body: 'fixture-sitemap-index', type: 'application/xml' },
  '/sitemap-0.xml': { body: 'fixture-sitemap-child', type: 'application/xml' },
  '/getting-started/index.md': { body: '# fixture-getting-started', type: 'text/markdown; charset=utf-8' },
  '/404.html': { body: '<!doctype html><title>fixture-404-nav</title>', type: 'text/html; charset=utf-8' },
  '/version.json': { body: '{"sha":"fixture"}', type: 'application/json' },
  '/_astro/app.ABCdef12.js': { body: 'fixture-asset', type: 'text/javascript' },
  '/_astro/app.js': { body: 'fixture-unhashed-asset', type: 'text/javascript' },
  '/assets/logo.abcdefgh.svg': { body: 'fixture-hashed-image', type: 'image/svg+xml' },
};

function createHarness() {
  const requested: string[] = [];
  const ASSETS: AssetBinding = {
    async fetch(request) {
      const url = new URL(request.url);
      requested.push(`${request.method} ${url.pathname}`);
      const fixture = fixtures[url.pathname];
      const etag = `"${url.pathname}"`;
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      if (!fixture) return new Response(fixtures['/404.html']!.body, {
        status: 404,
        headers: { 'content-type': fixtures['/404.html']!.type, etag },
      });
      return new Response(fixture.body, {
        headers: { 'content-type': fixture.type, etag: `"${url.pathname}"` },
      });
    },
  };
  const fetch = createWorker({ '/': '/index.md', '/guide/': '/guide/index.md', '/getting-started/': 'getting-started/index.md' });
  const run = (path: string, init: RequestInit = {}) => fetch(
    new Request(new URL(path, 'https://wseffect.com'), init),
    { ASSETS },
    { waitUntil() {} },
  );
  return { run, requested };
}

test('known pages and metadata use revalidation headers', async () => {
  const { run } = createHarness();
  for (const path of ['/guide/', '/robots.txt', '/sitemap-index.xml', '/sitemap-0.xml', '/version.json']) {
    const response = await run(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
});

test('Markdown Accept negotiation honors supported types and q values', async () => {
  const { run, requested } = createHarness();
  for (const accept of ['text/markdown', 'text/x-markdown;q=0.8,text/html;q=0.2', 'text/markdown;q=0.4,text/html;q=0']) {
    const response = await run('/guide/', { headers: { accept } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/markdown/, `Accept: ${accept}`);
    assert.equal(response.headers.get('vary'), 'Accept');
  }
  assert.equal(requested.filter((value) => value.endsWith('/guide/index.md')).length, 3);
  for (const accept of [
    'text/markdown;q=0',
    'text/markdown;q=0.2,text/html;q=0.8',
    'text/markdown;q=0.4,text/*;q=0.8',
    'text/markdown;q=0,text/*;q=0.8',
    'text/markdown;q=0,text/*;q=0.8,text/html;q=0',
    'text/markdown;q=0,text/x-markdown;q=0.8,text/html;q=0',
    'text/markdown;q=0.8,text/html;q=0.8',
    '*/*;q=0.6',
  ]) {
    const response = await run('/guide/', { headers: { accept } });
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, `Accept: ${accept}`);
    assert.equal(response.headers.get('vary'), 'Accept');
  }
});
test('resolves relative Markdown twins from the origin root', async () => {
  const { run, requested } = createHarness();
  const response = await run('/getting-started/', { headers: { accept: 'text/markdown' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '# fixture-getting-started');
  assert.equal(requested.includes('GET /getting-started/index.md'), true);
});

test('preserves conditional Markdown 304 validators, cache policy, Vary, and HEAD parity', async () => {
  const { run } = createHarness();
  const headers = {
    accept: 'text/markdown',
    'if-none-match': '"/getting-started/index.md"',
  };
  const get = await run('/getting-started/', { headers });
  const head = await run('/getting-started/', { method: 'HEAD', headers });
  assert.equal(get.status, 304);
  assert.equal(get.headers.get('etag'), '"/getting-started/index.md"');
  assert.equal(get.headers.get('cache-control'), 'no-cache');
  assert.equal(get.headers.get('vary'), 'Accept');
  assert.equal(head.status, get.status);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(await head.text(), '');
});

test('known HTML variants include Vary: Accept', async () => {
  const response = await createHarness().run('/guide/');
  assert.equal(response.headers.get('vary'), 'Accept');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});

test('known noncanonical routes redirect before negotiation and preserve query', async () => {
  const { run, requested } = createHarness();
  const response = await run('/guide?topic=one', { headers: { accept: 'text/markdown' } });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://wseffect.com/guide/?topic=one');
  assert.deepEqual(requested, []);
});

test('www redirect precedes negotiation and preserves path and query', async () => {
  const fetch = createWorker({ '/guide/': '/guide/index.md' });
  const response = await fetch(
    new Request('https://www.wseffect.com/guide/?q=one', { headers: { accept: 'text/markdown' } }),
    { ASSETS: { async fetch() { throw new Error('must not fetch assets'); } } },
    { waitUntil() {} },
  );
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://wseffect.com/guide/?q=one');
});

test('unknown extensionless and missing extension-bearing paths remain 404', async () => {
  const { run, requested } = createHarness();
  for (const path of ['/missing-route', '/missing-route/', '/missing.js', '/missing-image.webp']) {
    const response = await run(path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const body = await response.text();
    assert.match(body, /fixture-404-nav/);
    assert.doesNotMatch(body, /fixture-root/);
  }
  assert.equal(requested.includes('GET /index.html'), false);
});

test('missing Markdown twins remain 404 and vary by Accept', async () => {
  const fetch = createWorker({ '/guide/': '/guide/missing.md' });
  const response = await fetch(
    new Request('https://wseffect.com/guide/', { headers: { accept: 'text/markdown' } }),
    { ASSETS: { async fetch() { return new Response('absent', { status: 404 }); } } },
    { waitUntil() {} },
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('vary'), 'Accept');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});

test('HEAD matches GET status and headers without a body', async () => {
  const { run } = createHarness();
  const get = await run('/guide/', { headers: { accept: 'text/markdown' } });
  const head = await run('/guide/', { method: 'HEAD', headers: { accept: 'text/markdown' } });
  assert.equal(head.status, get.status);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(await head.text(), '');
});

test('only successful hash-named assets receive immutable caching', async () => {
  const { run } = createHarness();
  const hashed = await run('/_astro/app.ABCdef12.js');
  const hashedOutsideAstro = await run('/assets/logo.abcdefgh.svg');
  const unhashed = await run('/_astro/app.js');
  const missing = await run('/_astro/missing.ABCdef12.js');
  assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(hashedOutsideAstro.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(unhashed.headers.get('cache-control'), 'no-cache');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-cache');
});

test('methods other than GET and HEAD are rejected', async () => {
  const response = await createHarness().run('/guide/', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});
