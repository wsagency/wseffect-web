import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stage(name: string, command: string, args: readonly string[]): void {
  console.log(`\n=== ${name} ===`)
  const result = spawnSync(command, [...args], { cwd: root, stdio: 'inherit' })
  if (result.error) throw new Error(`${name}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${name} failed (${result.signal ?? result.status})`)
}

async function unitTests(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await unitTests(path))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files.sort()
}

stage('Production build', 'pnpm', ['build'])
stage('Published export inventory', process.execPath, ['scripts/inventory.ts', '--check'])
stage('Public schema Props', process.execPath, ['scripts/props.ts', '--check'])
stage('Published API reference', process.execPath, ['scripts/api-reference.ts', '--check'])
stage('Routes, links and Markdown', process.execPath, ['scripts/check-links.ts'])
stage('Published API snippets', process.execPath, ['scripts/snippets.ts'])
const tests = (await Promise.all(['scripts', 'worker', 'src/lib', 'src/islands'].map(unitTests))).flat().sort()
if (tests.length === 0) throw new Error('No behavioral unit tests found')
stage('Behavioral unit tests', process.execPath, ['--test', ...tests])
stage('Downloaded registry starters', process.execPath, ['scripts/starters.ts', '--check'])
stage('Chromium, Firefox, WebKit and accessibility', 'pnpm', ['exec', 'playwright', 'test'])
console.log('\nWebsite acceptance passed.')
