import { homedir } from 'node:os'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const docsRoot = join(siteRoot, 'src/content/docs')

type Classification = 'compile' | 'fragment'
export type CodeExample = Readonly<{ file: string; language: string; classification: Classification; source: string; reason: string }>

async function mdxFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await mdxFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.mdx')) files.push(path)
  }
  return files.sort()
}

function proseContext(lines: readonly string[], start: number, end: number): string | undefined {
  for (let index = start - 1; index >= 0; index--) {
    const text = lines[index].trim()
    if (text && !text.startsWith('#') && !text.startsWith('---') && !text.startsWith('```') && !text.startsWith('~~~')) return text
  }
  for (let index = end + 1; index < lines.length; index++) {
    const text = lines[index].trim()
    if (text && !text.startsWith('#') && !text.startsWith('```') && !text.startsWith('~~~')) return text
  }
  return undefined
}

export function extractTypescriptExamples(file: string, source: string): CodeExample[] {
  const lines = source.split(/\r?\n/)
  const examples: CodeExample[] = []
  for (let index = 0; index < lines.length; index++) {
    const opener = lines[index].match(/^\s*(`{3,}|~{3,})\s*([^\s]+)(.*)$/)
    if (!opener) continue
    const fence = opener[1][0].repeat(opener[1].length)
    const language = opener[2].toLowerCase()
    const metadata = opener[3].trim().split(/\s+/).filter(Boolean)
    let close = index + 1
    while (close < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[close])) close++
    if (close >= lines.length) throw new Error(`${file}:${index + 1}: unclosed ${language} code fence`)
    if (language === 'ts' || language === 'typescript' || language === 'tsx') {
      const classification = metadata.filter((item) => item === 'compile' || item === 'fragment')
      if (classification.length !== 1) throw new Error(`${file}:${index + 1}: TypeScript fence must be explicitly classified with exactly one of 'compile' or 'fragment'`)
      const context = proseContext(lines, index, close)
      if (classification[0] === 'fragment' && !context) throw new Error(`${file}:${index + 1}: contextual fragment needs surrounding explanatory prose`)
      const snippet = lines.slice(index + 1, close).join('\n')
      if (!snippet.trim()) throw new Error(`${file}:${index + 1}: TypeScript example is empty`)
      const languageOption = language === 'tsx' ? 'tsx' : 'ts'
      examples.push({
        file,
        language: languageOption,
        classification: classification[0] as Classification,
        source: snippet,
        reason: classification[0] === 'fragment' ? context! : 'Standalone TypeScript example checked against the installed package declarations.',
      })
    }
    index = close
  }
  return examples
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map((diagnostic) => {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? `${relative(siteRoot, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `
      : ''
    return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  }).join('\n')
}

export async function checkSnippets(): Promise<Readonly<{ compiled: number; fragments: number }>> {
  const examples: CodeExample[] = []
  for (const file of await mdxFiles(docsRoot)) examples.push(...extractTypescriptExamples(relative(siteRoot, file), await readFile(file, 'utf8')))
  if (!examples.length) throw new Error('No TypeScript documentation examples were found')
  const runnable = examples.filter((example) => example.classification === 'compile')
  const fragments = examples.filter((example) => example.classification === 'fragment')
  if (!runnable.length) throw new Error('At least one TypeScript example must be classified as compile')
  const cacheRoot = process.env.TMPDIR ?? join(homedir(), '.cache/wseffect-work')
  await mkdir(cacheRoot, { recursive: true })
  const tempRoot = await mkdtemp(join(cacheRoot, 'snippets-'))
  try {
    await symlink(join(siteRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'dir')
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    const files: string[] = []
    for (let index = 0; index < runnable.length; index++) {
      const example = runnable[index]
      const extension = example.language === 'tsx' ? 'tsx' : 'mts'
      const file = join(tempRoot, `example-${String(index + 1).padStart(3, '0')}.${extension}`)
      await writeFile(file, `${example.source}\nexport {}\n`)
      files.push(file)
    }
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      jsx: ts.JsxEmit.Preserve,
      // Module resolution walks through the temporary node_modules symlink.
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length) throw new Error(`Runnable documentation examples do not type-check:\n${formatDiagnostics(diagnostics)}`)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
  for (const example of fragments) console.log(`fragment ${example.file}: ${example.reason}`)
  console.log(`Type-checked ${runnable.length} runnable examples; classified ${fragments.length} contextual fragments.`)
  return { compiled: runnable.length, fragments: fragments.length }
}


if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await checkSnippets()
