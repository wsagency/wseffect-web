import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const pagefindCli = join(siteRoot, 'node_modules/pagefind/lib/runner/bin.cjs')
const output = join(siteRoot, 'out')

export async function buildSearchIndex(): Promise<void> {
  await access(output, constants.R_OK)
  const result = spawnSync(process.execPath, [pagefindCli, '--site', output, '--output-subdir', 'pagefind'], {
    cwd: siteRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Pagefind failed (${result.signal ?? result.status})`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildSearchIndex()
