import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportRoutes } from '../src/data/export-routes.ts';

export type InventoryEntry = {
  packageName: string;
  exportPath: string;
  route: string;
  anchor?: string;
  kind: 'api' | 'style' | 'metadata';
  sourceUrl: string;
};

const sourceDirectories: Readonly<Record<string, string>> = {
  '@wsagency/wseffect-app': 'app',
  '@wsagency/wseffect-themes': 'themes',
  '@wsagency/wseffect-foldkit': 'foldkit',
  '@wsagency/wseffect-foldkit-ui': 'foldkit-ui',
  '@wsagency/wseffect-vite-plugin': 'vite-plugin',
};
const sourceTag = 'v0.1.0-rc.1';

function assignmentFor(packageName: string, exportPath: string) {
  const packageRoutes = exportRoutes[packageName as keyof typeof exportRoutes] as
    | Readonly<Record<string, { route: string; anchor?: string; kind?: InventoryEntry['kind'] }>>
    | undefined;
  return packageRoutes?.[exportPath];
}
export function validateRouteAssignments(assignments: ReadonlyArray<Pick<InventoryEntry, 'route' | 'anchor'>>): void {
  const seen = new Set<string>();
  for (const { route, anchor } of assignments) {
    const key = `${route}#${anchor ?? ''}`;
    if (seen.has(key)) throw new Error(`Duplicate route assignment: ${route}${anchor ? `#${anchor}` : ''}`);
    seen.add(key);
  }
}


export function buildInventory(
  packageExports: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ReadonlyArray<InventoryEntry> {
  const entries: InventoryEntry[] = [];
  const seenExports = new Set<string>();

  for (const packageName of Object.keys(packageExports).sort()) {
    const sourceDirectory = sourceDirectories[packageName];
    if (!sourceDirectory) throw new Error(`No source directory registered for package ${packageName}`);
    const exports = packageExports[packageName]!;
    for (const exportPath of Object.keys(exports).sort()) {
      const assignment = assignmentFor(packageName, exportPath);
      if (!assignment) throw new Error(`Unmapped public export: ${packageName} ${exportPath}`);
      const { route, anchor, kind } = assignment;
      if (!route.startsWith('/') || !route.endsWith('/')) {
        throw new Error(`Invalid canonical route for ${packageName} ${exportPath}: ${route}`);
      }
      if (anchor && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(anchor)) {
        throw new Error(`Invalid route anchor for ${packageName} ${exportPath}: ${anchor}`);
      }
      const exportKey = `${packageName}\0${exportPath}`;
      if (seenExports.has(exportKey)) throw new Error(`Duplicate export: ${packageName} ${exportPath}`);
      seenExports.add(exportKey);
      entries.push({
        packageName,
        exportPath,
        route,
        ...(anchor ? { anchor } : {}),
        kind: kind ?? (exportPath.endsWith('.css') || exportPath.includes('.layer.css') ? 'style' : exportPath.endsWith('/package.json') ? 'metadata' : 'api'),
        sourceUrl: `https://github.com/wsagency/wseffect/tree/${sourceTag}/packages/${sourceDirectory}`,
      });
    }
  }
  validateRouteAssignments(entries);

  for (const packageName of Object.keys(exportRoutes)) {
    if (!packageExports[packageName]) throw new Error(`Route mappings exist for missing package ${packageName}`);
    const exports = new Set(Object.keys(packageExports[packageName]!));
    for (const exportPath of Object.keys(exportRoutes[packageName as keyof typeof exportRoutes])) {
      if (!exports.has(exportPath)) throw new Error(`Stale route mapping: ${packageName} ${exportPath}`);
    }
  }

  return entries;
}

async function findPackageManifest(packageName: string): Promise<{ manifestPath: string; manifest: { name: string; exports?: Readonly<Record<string, unknown>> } }> {
  const resolved = import.meta.resolve(packageName);
  if (!resolved.startsWith('file:')) throw new Error(`Expected a file URL for ${packageName}, got ${resolved}`);
  let directory = dirname(fileURLToPath(resolved));
  for (;;) {
    const manifestPath = join(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name: string; exports?: Readonly<Record<string, unknown>> };
      if (manifest.name === packageName) return { manifestPath, manifest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) break;
    directory = parent;
  }
  throw new Error(`Could not find the installed manifest for ${packageName}`);
}

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = join(siteRoot, 'src/data/export-inventory.json');

export async function generateInventory(check = false): Promise<ReadonlyArray<InventoryEntry>> {
  const packageExports: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const packageName of Object.keys(sourceDirectories).sort()) {
    const { manifest } = await findPackageManifest(packageName);
    if (!manifest.exports || typeof manifest.exports !== 'object') throw new Error(`No exports map in ${packageName}`);
    packageExports[packageName] = manifest.exports;
  }
  const inventory = buildInventory(packageExports);
  const output = `${JSON.stringify(inventory, null, 2)}\n`;
  if (check) {
    let saved: string;
    try {
      saved = await readFile(outputPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Missing generated inventory: ${outputPath}`);
      throw error;
    }
    if (saved !== output) throw new Error(`Generated inventory is stale: ${outputPath}; run node scripts/inventory.ts`);
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);
  }
  return inventory;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.slice(2).includes('--check');
  generateInventory(check).then((entries) => {
    console.log(`${check ? 'Verified' : 'Wrote'} ${entries.length} package exports`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
