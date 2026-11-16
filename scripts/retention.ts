import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const DEFAULT_ASSET_LIMITS = Object.freeze({
  // Free Workers permit 20,000 files; keep one thousand slots as headroom.
  maxFiles: 19_000,
  // Cloudflare permits 25 MiB per asset; retain 1 MiB of margin.
  maxFileBytes: 24 * 1024 * 1024,
});

export interface RetainedAsset {
  readonly path: string;
  readonly sourceSha: string;
}

export interface RetentionResult {
  readonly releases: readonly string[];
  readonly retainedAssets: readonly RetainedAsset[];
  readonly assetCount: number;
  readonly totalBytes: number;
}

export interface AssetLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

interface TreeFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
}

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const HASHED_FILENAME = /\.[A-Za-z0-9_-]{8,}\.[^/]+$/;

async function assertRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a real directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readTree(root: string): Promise<TreeFile[]> {
  if (!(await assertRealDirectory(root))) return [];
  const files: TreeFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`Symlink is not permitted in asset trees: ${absolutePath}`);
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        files.push({ absolutePath, relativePath: relative(root, absolutePath), size: info.size });
      } else {
        throw new Error(`Unsupported filesystem entry in asset tree: ${absolutePath}`);
      }
    }
  };
  await visit(root);
  return files;
}

async function readReleaseOrder(releaseStore: string): Promise<string[]> {
  if (!(await assertRealDirectory(releaseStore))) return [];
  const manifestPath = join(releaseStore, 'releases.json');
  const manifestInfo = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!manifestInfo) {
    if ((await readdir(releaseStore)).length > 0) throw new Error('Non-empty release store is missing releases.json');
    return [];
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error(`Release manifest must be a regular file: ${manifestPath}`);
  }
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('releases' in parsed) || !Array.isArray(parsed.releases)) {
    throw new Error('Release manifest must contain a releases array ordered newest first');
  }
  const releases: unknown[] = parsed.releases;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const sha of releases) {
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new Error('Release manifest contains an invalid source SHA');
    if (seen.has(sha)) throw new Error(`Release manifest contains duplicate source SHA: ${sha}`);
    seen.add(sha);
    result.push(sha);
  }
  return result;
}

function assertSafePath(root: string, path: string): void {
  const resolved = resolve(path);
  const relativePath = relative(root, resolved);
  if (relativePath === '' || relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    throw new Error(`Asset path escapes its configured root: ${path}`);
  }
}

export async function mergeRetainedAssets(
  outDir: string,
  releaseStore: string,
  currentSha: string,
  retainCount = 3,
  limits: AssetLimits = DEFAULT_ASSET_LIMITS,
): Promise<RetentionResult> {
  if (!SHA_PATTERN.test(currentSha)) throw new Error(`Invalid current source SHA: ${currentSha}`);
  if (!Number.isInteger(retainCount) || retainCount < 0) throw new Error('retainCount must be a non-negative integer');
  if (!Number.isInteger(limits.maxFiles) || limits.maxFiles < 0 || !Number.isInteger(limits.maxFileBytes) || limits.maxFileBytes < 0) {
    throw new Error('Asset limits must be non-negative integers');
  }

  const outputRoot = resolve(outDir);
  const storeRoot = resolve(releaseStore);
  const currentAssetRoot = join(outputRoot, '_astro');
  const outputFiles = await readTree(outputRoot);
  const releaseOrder = await readReleaseOrder(storeRoot);
  const previousShas = releaseOrder.filter((sha) => sha.toLowerCase() !== currentSha.toLowerCase()).slice(0, retainCount);
  const pending = new Map<string, { file: TreeFile; sourceSha: string }>();

  for (const sha of previousShas) {
    const releaseRoot = join(storeRoot, sha);
    const releaseAstro = join(releaseRoot, '_astro');
    if (!(await assertRealDirectory(releaseRoot))) throw new Error(`Release source tree is missing: ${releaseRoot}`);
    if (!(await assertRealDirectory(releaseAstro))) throw new Error(`Release asset tree is missing: ${releaseAstro}`);
    const sourceFiles = await readTree(releaseRoot);
    const assetPrefix = `_astro${sep}`;
    for (const file of sourceFiles) {
      if (!file.relativePath.startsWith(assetPrefix)) continue;
      const assetRelativePath = file.relativePath.slice(assetPrefix.length);
      if (!HASHED_FILENAME.test(assetRelativePath.split(sep).at(-1) ?? '')) continue;
      const destination = join(currentAssetRoot, assetRelativePath);
      assertSafePath(currentAssetRoot, destination);
      const existing = outputFiles.find((current) => current.absolutePath === destination);
      if (existing) {
        const [existingBytes, retainedBytes] = await Promise.all([
          readFile(existing.absolutePath),
          readFile(file.absolutePath),
        ]);
        if (!existingBytes.equals(retainedBytes)) {
          throw new Error(`Asset collision with different bytes: ${destination} (source ${sha})`);
        }
        continue;
      }
      const prior = pending.get(destination);
      if (prior) {
        const [priorBytes, retainedBytes] = await Promise.all([
          readFile(prior.file.absolutePath),
          readFile(file.absolutePath),
        ]);
        if (!priorBytes.equals(retainedBytes)) {
          throw new Error(`Asset collision with different bytes: ${destination} (${prior.sourceSha} vs ${sha})`);
        }
        continue;
      }
      pending.set(destination, { file, sourceSha: sha });
    }
  }

  const existingPaths = new Set(outputFiles.map((file) => file.absolutePath));
  for (const destination of pending.keys()) {
    let parent = dirname(destination);
    while (parent !== currentAssetRoot) {
      if (existingPaths.has(parent)) throw new Error(`Asset destination parent is a file: ${parent}`);
      parent = dirname(parent);
    }
  }
  const finalFiles = new Map<string, number>();
  for (const file of outputFiles) finalFiles.set(file.absolutePath, file.size);
  for (const [path, value] of pending) finalFiles.set(path, value.file.size);
  if (finalFiles.size > limits.maxFiles) {
    throw new Error(`Static asset file count ${finalFiles.size} exceeds configured limit ${limits.maxFiles}`);
  }
  let totalBytes = 0;
  for (const [path, size] of finalFiles) {
    if (size > limits.maxFileBytes) throw new Error(`Static asset ${path} is ${size} bytes; configured per-file limit is ${limits.maxFileBytes}`);
    totalBytes += size;
  }

  // All path, symlink, collision, and limit checks finish before the first write.
  await assertRealDirectory(outputRoot);
  if (!(await assertRealDirectory(currentAssetRoot))) await mkdir(currentAssetRoot, { recursive: true });
  for (const [destination, value] of pending) {
    let directory = dirname(destination);
    const parents: string[] = [];
    while (directory !== currentAssetRoot) {
      parents.push(directory);
      directory = dirname(directory);
    }
    for (const parent of parents.reverse()) {
      if (!(await assertRealDirectory(parent))) await mkdir(parent);
    }
    await copyFile(value.file.absolutePath, destination, constants.COPYFILE_EXCL);
  }

  const retainedAssets = [...pending.entries()]
    .map(([path, value]) => ({ path: `/_astro/${relative(currentAssetRoot, path).split(sep).join('/')}`, sourceSha: value.sourceSha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    releases: [currentSha, ...previousShas],
    retainedAssets,
    assetCount: finalFiles.size,
    totalBytes,
  };
}
