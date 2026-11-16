import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { buildInventory, validateRouteAssignments } from './inventory.ts';
import { exportRoutes } from '../src/data/export-routes.ts';

async function installedExports(): Promise<Record<string, Record<string, unknown>>> {
  const exports: Record<string, Record<string, unknown>> = {};
  for (const packageName of Object.keys(exportRoutes)) {
    let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
    for (;;) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; exports?: Record<string, unknown> };
        if (manifest.name === packageName && manifest.exports) {
          exports[packageName] = manifest.exports;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = dirname(directory);
      if (parent === directory || directory === parse(directory).root) throw new Error(`Could not locate installed ${packageName} manifest`);
      directory = parent;
    }
  }
  return exports;
}

function publishedExports(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(exportRoutes).map(([packageName, routes]) => [
    packageName,
    Object.fromEntries(Object.keys(routes).map((exportPath) => [exportPath, {}])),
  ]));
}

describe('buildInventory', () => {
  it('maps every installed published package export to its reviewed canonical route', async () => {
    const inventory = buildInventory(await installedExports());
    assert.equal(inventory.length, 243);
    assert.ok(inventory.some((entry) => entry.packageName === '@wsagency/wseffect-foldkit' && entry.exportPath === './experimental/server' && entry.route === '/foldkit/experimental/' && entry.anchor === 'server'));
    assert.ok(inventory.some((entry) => entry.packageName === '@wsagency/wseffect-foldkit-ui' && entry.exportPath === './datePicker' && entry.route === '/foldkit-ui/datePicker/'));
    assert.ok(inventory.some((entry) => entry.packageName === '@wsagency/wseffect-foldkit-ui' && entry.exportPath === './tooltip/group' && entry.route === '/foldkit-ui/tooltip/' && entry.anchor === 'group'));
    assert.ok(inventory.some((entry) => entry.packageName === '@wsagency/wseffect-themes' && entry.exportPath === './components/slider/range' && entry.route === '/themes/components/slider/' && entry.anchor === 'range'));
    assert.ok(inventory.some((entry) => entry.packageName === '@wsagency/wseffect-themes' && entry.exportPath === './styles/*' && entry.route === '/themes/css/' && entry.kind === 'style'));
    assert.ok(inventory.every((entry) => entry.sourceUrl.includes('/tree/v0.1.0-rc.1/packages/')));
  });

  it('rejects an unreviewed export instead of guessing its route', () => {
    assert.throws(() => buildInventory({ '@wsagency/wseffect-foldkit': { './new-module': {} } }), /Unmapped public export/);
  });

  it('rejects duplicate route and anchor assignments', () => {
    assert.throws(() => validateRouteAssignments([
      { route: '/example/', anchor: 'same' },
      { route: '/example/', anchor: 'same' },
    ]), /Duplicate route assignment/);
  });

  it('rejects stale route mappings for exports no longer published', () => {
    const exports = publishedExports();
    delete exports['@wsagency/wseffect-foldkit']!['./runtime'];
    assert.throws(() => buildInventory(exports), /Stale route mapping/);
  });
});

it('check mode rejects stale and malformed saved inventory without rewriting it', async () => {
  const siteRoot = fileURLToPath(new URL('../', import.meta.url));
  const tempRoot = join(homedir(), '.cache/wseffect-work/release-web/tmp');
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, 'inventory-check-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'src/data'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await copyFile(join(siteRoot, 'scripts/inventory.ts'), join(root, 'scripts/inventory.ts'));
    await copyFile(join(siteRoot, 'src/data/export-routes.ts'), join(root, 'src/data/export-routes.ts'));
    await symlink(join(siteRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/inventory.ts'), ...args], { cwd: root, encoding: 'utf8' });
    const generated = run();
    assert.equal(generated.status, 0, generated.stderr);
    const checked = run('--check');
    assert.equal(checked.status, 0, checked.stderr);
    const output = join(root, 'src/data/export-inventory.json');
    const entries = JSON.parse(await readFile(output, 'utf8'));
    entries[0].route = '/incorrect-destination/';
    for (const content of [`${JSON.stringify(entries, null, 2)}\n`, '{invalid-json']) {
      await writeFile(output, content);
      const rejected = run('--check');
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Generated inventory is stale/);
      assert.equal(await readFile(output, 'utf8'), content);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
