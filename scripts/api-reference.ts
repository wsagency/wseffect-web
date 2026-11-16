import ts from 'typescript'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InventoryEntry } from './inventory.ts'
import { themeExamples } from '../src/data/theme-examples.ts'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const inventoryPath = join(siteRoot, 'src/data/export-inventory.json')
const outputPath = join(siteRoot, 'generated/api-reference.json')

type PackageManifest = Readonly<{
  name: string
  version: string
  license?: string
  repository?: string | { url?: string; directory?: string; type?: string }
  exports?: Readonly<Record<string, unknown>>
  types?: string
  typings?: string
}>
export type ApiDeclaration = Readonly<{ name: string; documentation: string; signature: string }>
export type PackageNotice = Readonly<{ label: string; url: string }>
export type ApiReference = Readonly<{
  route: string
  anchor?: string
  packageName: string
  exportPath: string
  sourceUrl: string
  license: string
  version: string
  notices: ReadonlyArray<PackageNotice>
  declarations: ReadonlyArray<ApiDeclaration>
}>

function selectTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['types', 'typings', 'import', 'default', 'node']) {
    const selected = selectTarget(record[key])
    if (selected) return selected
  }
  for (const item of Object.values(record)) {
    const selected = selectTarget(item)
    if (selected) return selected
  }
  return undefined
}

function packageLocation(packageName: string): string {
  return resolve(siteRoot, 'node_modules', ...packageName.split('/'))
}

async function manifestFor(packageName: string): Promise<{ root: string; manifest: PackageManifest }> {
  const packagePath = packageLocation(packageName)
  const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8')) as PackageManifest
  return { root: await realpath(packagePath), manifest }
}

async function declarationFile(root: string, manifest: PackageManifest, exportPath: string): Promise<string> {
  const target = selectTarget(manifest.exports?.[exportPath]) ?? manifest.types ?? manifest.typings
  if (!target) throw new Error(`${manifest.name}${exportPath === '.' ? '' : exportPath}: no declaration target in installed package metadata`)
  const absoluteTarget = resolve(root, target.replace(/\.js$/, '.d.ts').replace(/\.mjs$/, '.d.mts'))
  const candidates = [absoluteTarget, resolve(root, target)]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile() && /\.d\.(?:ts|mts|cts)$/.test(candidate)) return candidate
    } catch { /* Try the package-level types fallback. */ }
  }
  throw new Error(`${manifest.name}${exportPath === '.' ? '' : exportPath}: declaration file not found at ${relative(root, absoluteTarget)}`)
}

function declarationText(node: ts.Declaration): string {
  return node.getText().replace(/\s+$/, '')
}

function docsText(node: ts.Node): string {
  const comments = ts.getJSDocCommentsAndTags(node)
  const seen = new Set<string>()
  const rendered: string[] = []
  for (const comment of comments) {
    const text = ts.isJSDoc(comment)
      ? comment.comment
      : comment.getText()
    const normalized = typeof text === 'string' ? text.trim() : ''
    if (normalized && !seen.has(normalized)) { seen.add(normalized); rendered.push(normalized) }
  }
  return rendered.join('\n\n')
}

function declarationsAt(program: ts.Program, filePath: string, publishedPackageRoots: ReadonlyArray<string>): ApiDeclaration[] {
  const source = program.getSourceFile(filePath)
  const checker = program.getTypeChecker()
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error(`Cannot read declaration module ${filePath}`)
  const exports = checker.getExportsOfModule(moduleSymbol)
  const found = new Map<string, ApiDeclaration>()
  for (const exported of exports) {
    const name = exported.getName()
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
    for (const declaration of symbol.getDeclarations() ?? []) {
      const declarationSource = declaration.getSourceFile()
      const declarationPath = resolve(declarationSource.fileName)
      if (!publishedPackageRoots.some((root) => declarationPath.startsWith(`${resolve(root)}/`)) || !/\.d\.(?:ts|mts|cts)$/.test(declarationPath)) continue
      const signature = declarationText(declaration)
      const key = `${name}\0${signature}`
      if (!found.has(key)) found.set(key, { name, documentation: docsText(declaration), signature })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.signature.localeCompare(b.signature))
}

async function packageNotices(root: string, manifest: PackageManifest): Promise<PackageNotice[]> {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const normalized = repository?.replace(/^git\+/, '').replace(/\.git$/, '')
  if (!normalized) throw new Error(`${manifest.name}: package repository URL is missing`)
  const directory = typeof manifest.repository === 'object' ? manifest.repository.directory : undefined
  const paths = ['LICENSE', 'WS-AGENCY-NOTICE.md', 'THIRD-PARTY-NOTICES.md']
  const notices: PackageNotice[] = []
  for (const path of paths) {
    try {
      if ((await stat(join(root, path))).isFile()) {
        const label = path === 'LICENSE' ? `${manifest.license ?? 'Package'} license` : path.replace(/\.md$/, '')
        notices.push({ label, url: `${normalized}/blob/v${manifest.version}/${directory ? `${directory}/` : ''}${path}` })
      }
    } catch { /* Optional published package notice. */ }
  }
  if (!notices.some((notice) => notice.label.endsWith('license'))) throw new Error(`${manifest.name}: installed LICENSE file is missing`)
  return notices
}

export async function generateApiReference(inventory?: ReadonlyArray<InventoryEntry>): Promise<ReadonlyArray<ApiReference>> {
  const entries = inventory ?? JSON.parse(await readFile(inventoryPath, 'utf8')) as InventoryEntry[]
  const apiEntries = entries.filter((entry) => entry.kind === 'api')
  const themeComponentEntries = apiEntries.filter((entry) => entry.packageName === '@wsagency/wseffect-themes' && entry.exportPath.startsWith('./components/'))
  const themeComponentExports = new Set(themeComponentEntries.map((entry) => entry.exportPath))
  for (const entry of themeComponentEntries) if (!themeExamples[entry.exportPath]) throw new Error(`No rendered example for ${entry.exportPath}`)
  for (const exportPath of Object.keys(themeExamples)) if (!themeComponentExports.has(exportPath)) throw new Error(`Example has no published Themes component export: ${exportPath}`)
  const packageData = new Map<string, { root: string; manifest: PackageManifest; targets: Map<string, string>; notices: Promise<PackageNotice[]> }>()
  for (const entry of apiEntries) {
    if (!packageData.has(entry.packageName)) {
      const { root, manifest } = await manifestFor(entry.packageName)
      const notices = packageNotices(root, manifest)
      packageData.set(entry.packageName, { root, manifest, targets: new Map(), notices })
    }
    const data = packageData.get(entry.packageName)!
    if (!data.targets.has(entry.exportPath)) data.targets.set(entry.exportPath, await declarationFile(data.root, data.manifest, entry.exportPath))
  }
  const examplePath = join(siteRoot, 'src/data/theme-examples.ts')
  const program = ts.createProgram([...new Set([...packageData.values()].flatMap((item) => [...item.targets.values()])), examplePath], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  })
  const exampleFile = program.getSourceFile(examplePath)
  if (!exampleFile) throw new Error(`Could not compile component examples from ${relative(siteRoot, examplePath)}`)
  const diagnostics = ts.getPreEmitDiagnostics(program, exampleFile)
  if (diagnostics.length) {
    const diagnosticHost: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => siteRoot,
      getNewLine: () => '\n',
    }
    throw new Error(`Published Themes component examples do not type-check:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost)}`)
  }
  const publishedPackageRoots = [...new Set([...packageData.values()].map((item) => resolve(item.root)))]
  const references: ApiReference[] = []
  for (const entry of apiEntries) {
    const data = packageData.get(entry.packageName)!
    const file = data.targets.get(entry.exportPath)!
    const declarations = declarationsAt(program, file, publishedPackageRoots)
    if (!declarations.length) throw new Error(`${entry.packageName}${entry.exportPath === '.' ? '' : entry.exportPath} has no exported declarations in ${relative(data.root, file)}`)
    references.push({
      route: entry.route,
      ...(entry.anchor ? { anchor: entry.anchor } : {}),
      packageName: entry.packageName,
      exportPath: entry.exportPath,
      sourceUrl: entry.sourceUrl,
      license: data.manifest.license ?? 'License not declared in package metadata',
      version: data.manifest.version,
      notices: await data.notices,
      declarations,
    })
  }
  return references
}
export async function generateApiReferenceFile(check = false): Promise<ReadonlyArray<ApiReference>> {
  const references = await generateApiReference()
  const output = `${JSON.stringify(references, null, 2)}\n`
  if (check) {
    const current = await readFile(outputPath, 'utf8')
    if (current !== output) throw new Error('generated/api-reference.json is stale; run scripts/api-reference.ts')
  } else {
    await mkdir(join(siteRoot, 'generated'), { recursive: true })
    await writeFile(outputPath, output)
  }
  return references
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  const references = await generateApiReferenceFile(check)
  console.log(`${check ? 'Verified' : 'Generated'} ${references.length} installed API exports across ${new Set(references.map((item) => item.route)).size} routes.`)
}

