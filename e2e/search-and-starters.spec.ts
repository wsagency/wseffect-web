import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('search finds and opens a component reference', async ({ page }) => {
  await page.goto('/search/')
  const search = page.getByRole('searchbox')
  await search.fill('dialog')
  const result = page.locator('main a[href*="/dialog/"]').first()
  await expect(result).toBeVisible({ timeout: 15_000 })
  await result.click()
  await expect(page).toHaveURL(/\/dialog\//)
  await expect(page.locator('main h1')).toBeVisible()
})

for (const [id, route] of [['minimal', '/getting-started/minimal/'], ['full', '/getting-started/app/']] as const) {
  test(`${id} starter download matches the independently build-checked artifact`, async ({ page, request }) => {
    await page.goto(route)
    const href = `/starters/wseffect-${id}-0.1.0-rc.1.tgz`
    const download = page.locator(`main a[href="${href}"]`).first()
    await expect(download).toBeVisible()
    const response = await request.get(href)
    expect(response.status()).toBe(200)
    const expected = await readFile(new URL(`../out${href}`, import.meta.url))
    expect(createHash('sha256').update(await response.body()).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'))
  })
}
