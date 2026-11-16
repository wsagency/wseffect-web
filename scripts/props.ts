import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PropsRow = Readonly<{
  name: string;
  type: string;
  required: boolean;
  choices?: ReadonlyArray<string>;
  description?: string;
}>;
type Ast = Readonly<Record<string, unknown>> & { _tag?: string };

function isAst(value: unknown): value is Ast {
  return typeof value === 'object' && value !== null && typeof (value as Ast)._tag === 'string';
}
function astOf(schema: unknown): Ast | undefined {
  if ((typeof schema !== 'object' && typeof schema !== 'function') || schema === null) return undefined;
  const ast = (schema as { ast?: unknown }).ast;
  return isAst(ast) ? ast : undefined;
}
function children(ast: Ast): ReadonlyArray<Ast> {
  return Array.isArray(ast.types) ? ast.types.filter(isAst) : [];
}
function isUndefined(ast: Ast): boolean {
  return ast._tag === 'Undefined';
}
function literalType(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  return String(value);
}
function responsiveValueTypes(ast: Ast): ReadonlyArray<Ast> {
  if (ast._tag !== 'Objects' || !Array.isArray(ast.propertySignatures)) return [];
  const props = ast.propertySignatures.filter((item): item is Ast => typeof item === 'object' && item !== null);
  const names = props.map((prop) => String(prop.name));
  const responsiveKeys = new Set(['initial', 'xs', 'sm', 'md', 'lg', 'xl']);
  if (names.length === 0 || names.some((name) => !responsiveKeys.has(name))) return [];
  return props.flatMap((prop) => isAst(prop.type) ? [prop.type] : []);
}
function formatObject(ast: Ast): string {
  if (!Array.isArray(ast.propertySignatures)) return 'object';
  if (Array.isArray(ast.indexSignatures) && ast.indexSignatures.length > 0) return 'Unsupported<ObjectIndexSignatures>';
  const signatures = ast.propertySignatures.filter((signature): signature is Ast => typeof signature === 'object' && signature !== null);
  const fields = signatures.map((signature) => {
    if (!isAst(signature.type)) return `${String(signature.name)}: unknown`;
    const optional = hasUndefined(signature.type) ? '?' : '';
    return `${String(signature.name)}${optional}: ${formatType(signature.type)}`;
  });
  return `{ ${fields.join('; ')} }`;
}
function formatArray(ast: Ast): string {
  const elements = Array.isArray(ast.elements) ? ast.elements.filter(isAst) : [];
  const rest = Array.isArray(ast.rest) ? ast.rest.filter(isAst) : [];
  if (elements.length === 0) return `Array<${rest.length ? rest.map(formatType).join(' | ') : 'unknown'}>`;
  return `[${elements.map(formatType).join(', ')}${rest.length ? `, ...${rest.map(formatType).join(' | ')}[]` : ''}]`;
}
function formatType(ast: Ast): string {
  switch (ast._tag) {
    case 'String': return 'string';
    case 'Number': return 'number';
    case 'Boolean': return 'boolean';
    case 'BigInt': return 'bigint';
    case 'Unknown': return 'unknown';
    case 'Null': return 'null';
    case 'Undefined': return 'undefined';
    case 'Literal': return literalType(ast.literal);
    case 'Union': return children(ast).filter((child) => !isUndefined(child)).map(formatType).join(' | ') || 'undefined';
    case 'Objects': {
      const values = responsiveValueTypes(ast);
      return values.length ? `Responsive<${[...new Set(values.map(formatType))].join(' | ')}>` : formatObject(ast);
    }
    case 'Tuples':
    case 'Arrays': return formatArray(ast);
    default: return `Unsupported<${ast._tag ?? 'unknown-node'}>`;
  }
}
function literalChoices(ast: Ast): ReadonlyArray<string> | undefined {
  const literals: string[] = [];
  const visit = (node: Ast): boolean => {
    if (isUndefined(node)) return true;
    if (node._tag === 'Literal') {
      literals.push(literalType(node.literal));
      return true;
    }
    if (node._tag === 'Union') return children(node).every(visit);
    return false;
  };
  if (!visit(ast) || literals.length === 0) return undefined;
  return [...new Set(literals)];
}
function hasUndefined(ast: Ast): boolean {
  return isUndefined(ast) || (ast._tag === 'Union' && children(ast).some(hasUndefined));
}
function descriptionOf(ast: Ast): string | undefined {
  const annotations = ast.annotations as { description?: unknown } | undefined;
  return typeof annotations?.description === 'string' ? annotations.description : undefined;
}

export function propsRows(propsSchema: unknown): ReadonlyArray<PropsRow> {
  const ast = astOf(propsSchema);
  if (!ast || ast._tag !== 'Objects' || !Array.isArray(ast.propertySignatures)) return [];
  return ast.propertySignatures.flatMap((signature): PropsRow[] => {
    if (typeof signature !== 'object' || signature === null || !isAst((signature as Ast).type)) return [];
    const property = signature as Ast;
    const type = property.type as Ast;
    const optional = (type.context as { isOptional?: unknown } | undefined)?.isOptional === true || hasUndefined(type);
    const choices = literalChoices(type);
    const description = descriptionOf(type) ?? descriptionOf(property);
    return [{
      name: String(property.name),
      type: formatType(type),
      required: !optional,
      ...(choices ? { choices } : {}),
      ...(description ? { description } : {}),
    }];
  });
}

export type PropsSchemaEntry = Readonly<{ schemaName: string; rows: ReadonlyArray<PropsRow> }>;
export type PropsByExport = Readonly<Record<string, ReadonlyArray<PropsSchemaEntry>>>;

export function collectPropsSchemas(module: Readonly<Record<string, unknown>>): ReadonlyArray<PropsSchemaEntry> {
  const schemas: PropsSchemaEntry[] = [];
  const visited = new Set<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'Props' && astOf(child)) {
        schemas.push({ schemaName: path ? `${path}.Props` : 'Props', rows: propsRows(child) });
      } else if (key !== 'ast' && key !== 'fields' && typeof child === 'object' && child !== null) {
        visit(child, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(module, '');
  return schemas.sort((a, b) => a.schemaName.localeCompare(b.schemaName));
}

const packageName = '@wsagency/wseffect-themes';
const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = join(siteRoot, 'generated/props.json');

async function findManifest(): Promise<{ exports: Readonly<Record<string, unknown>> }> {
  const resolved = import.meta.resolve(packageName);
  if (!resolved.startsWith('file:')) throw new Error(`Expected a file URL for ${packageName}, got ${resolved}`);
  let directory = dirname(fileURLToPath(resolved));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; exports?: Readonly<Record<string, unknown>> };
      if (manifest.name === packageName && manifest.exports) return { exports: manifest.exports };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) break;
    directory = parent;
  }
  throw new Error(`Could not find installed manifest for ${packageName}`);
}

export async function generateProps(check = false): Promise<PropsByExport> {
  const manifest = await findManifest();
  const inventory = JSON.parse(await readFile(join(siteRoot, 'src/data/export-inventory.json'), 'utf8')) as ReadonlyArray<{ packageName: string; exportPath: string; kind: string }>;
  const themesInventory = new Map(inventory.filter((entry) => entry.packageName === packageName).map((entry) => [entry.exportPath, entry.kind]));
  const generated: Record<string, ReadonlyArray<PropsSchemaEntry>> = {};
  for (const exportPath of Object.keys(manifest.exports).sort()) {
    const kind = themesInventory.get(exportPath);
    if (!kind) throw new Error(`Themes export is missing from inventory: ${exportPath}`);
    if (kind !== 'api') continue;
    const specifier = exportPath === '.' ? packageName : `${packageName}/${exportPath.slice(2)}`;
    // The import specifier is selected from the installed package's public export map.
    const module = await import(specifier) as Readonly<Record<string, unknown>>;
    const schemas = collectPropsSchemas(module);
    if (schemas.length) generated[exportPath] = schemas;
  }
  const output = `${JSON.stringify(generated, null, 2)}\n`;
  if (check) {
    let saved: string;
    try {
      saved = await readFile(outputPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Missing generated Props: ${outputPath}`);
      throw error;
    }
    if (saved !== output) throw new Error('Generated Props drift: regenerate with `pnpm props` and review the schema changes.');
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);
  }
  return generated;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.slice(2).includes('--check');
  generateProps(check).then((generated) => {
    const schemaCount = Object.values(generated).reduce((count, schemas) => count + schemas.length, 0);
    console.log(`${check ? 'Verified' : 'Wrote'} ${schemaCount} Props schemas from ${Object.keys(generated).length} Themes exports`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
