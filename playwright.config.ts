import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const diagnosticDir = process.env.WSEFFECT_PLAYWRIGHT_REPORT_DIR

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: diagnosticDir ? resolve(diagnosticDir, 'artifacts') : 'test-results',
  reporter: diagnosticDir
    ? [['list'], ['html', { outputFolder: resolve(diagnosticDir, 'html'), open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8787 --log-level warn',
    url: 'http://127.0.0.1:8787/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_API_TOKEN: '',
      CLOUDFLARE_ACCOUNT_ID: '',
    },
  },
})
