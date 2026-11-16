import { expect, test } from '@playwright/test'
import axe from 'axe-core'

declare global {
  interface Window { axe: typeof axe }
}

for (const route of ['/', '/getting-started/', '/concepts/model-message-update-view/', '/themes/components/button/']) {
  test(`${route} remains readable without client JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
      const page = await context.newPage()
      const response = await page.goto(`http://127.0.0.1:8787${route}`)
      expect(response?.status()).toBe(200)
      await expect(page.locator('main')).toBeVisible()
      await expect(page.locator('main h1')).toBeVisible()
      await expect(page.locator('script[src], script:not([type="application/ld+json"]):not([type="application/json"])')).toHaveCount(0)
      const link = page.locator('a[href="/getting-started/minimal/"]').first()
      if (route === '/getting-started/') {
        await link.click()
        await expect(page).toHaveURL(/\/getting-started\/minimal\/$/)
      }
    } finally {
      await context.close()
    }
  })
}

for (const route of ['/', '/getting-started/', '/themes/components/button/', '/demos/', '/search/']) {
  test(`${route} meets WCAG accessibility checks`, async ({ page }) => {
    await page.goto(route)
    await page.evaluate(() => document.fonts.ready)
    await page.addScriptTag({ content: axe.source })
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })
      return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) }))
    })
    expect(violations).toEqual([])
  })
}

test('mobile documentation has no page-wide horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/getting-started/app/')
  await expect(page.locator('main h1')).toBeVisible()
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
})

test('Worker negotiates Markdown and preserves HEAD headers', async ({ request }) => {
  const route = '/getting-started/'
  const html = await request.get(route, { headers: { Accept: 'text/html' } })
  expect(html.status()).toBe(200)
  expect(html.headers()['content-type']).toContain('text/html')
  expect(html.headers()['vary']?.toLowerCase()).toContain('accept')
  const markdown = await request.get(route, { headers: { Accept: 'text/markdown' } })
  expect(markdown.status()).toBe(200)
  expect(markdown.headers()['content-type']).toContain('text/markdown')
  expect(markdown.headers()['cache-control']).toBe('no-cache')
  expect(markdown.headers()['vary']?.toLowerCase()).toContain('accept')
  expect(await markdown.text()).toMatch(/^#\s/m)
  const head = await request.head(route, { headers: { Accept: 'text/markdown' } })
  expect(head.status()).toBe(markdown.status())
  for (const header of ['content-type', 'cache-control', 'vary']) expect(head.headers()[header]).toBe(markdown.headers()[header])
  expect((await head.body()).byteLength).toBe(0)
})

test('unknown pages and missing assets remain 404', async ({ request, page }) => {
  for (const route of ['/not-a-documentation-route/', '/_astro/not-a-real-chunk.js', '/missing-logo.png']) {
    const response = await request.get(route)
    expect(response.status()).toBe(404)
    expect(response.headers()['cache-control']).toBe('no-cache')
  }
  const response = await page.goto('/not-a-documentation-route/')
  expect(response?.status()).toBe(404)
  await expect(page.locator('main')).toBeVisible()
  await page.locator('a[href="/getting-started/"]').first().click()
  await expect(page).toHaveURL(/\/getting-started\/$/)
})
