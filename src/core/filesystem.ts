import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fingerprintFromStats, type Fingerprint } from "./types.js";
import { isSafePath, safeRealPath, samePath } from "./paths.js";

export interface TreeStats {
  bytes: number;
  fileCount: number;
  symlinkCount: number;
  /** True when a bound was hit: `bytes` is a lower bound, not a total. */
  partial: boolean;
  fingerprint: Fingerprint;
}

export interface MeasureCache {
  get(key: string): TreeStats | undefined;
  set(key: string, value: TreeStats): void;
}

export function measureCacheKey(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.mtimeMs}`;
}

export function createMeasureCache(): MeasureCache {
  const store = new Map<string, TreeStats>();
  return {
    get: (key) => store.get(key),
    set: (key, value) => void store.set(key, value),
  };
}

const maxEntries = 250_000;
const measureEntryCap = 2_000_000;

/** Small bounded-concurrency gate; caps parallel directory reads/stats, no dependency needed. */
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

interface WalkLimits {
  maxEntries: number;
  maxDepth: number;
  deadline: number;
}

interface WalkAccum {
  bytes: number;
  fileCount: number;
  symlinkCount: number;
  entries: number;
  partial: boolean;
}

/**
 * Shared walker for measureTree and approximateTree. Never follows symlinks: a symlinked
 * dirent is counted (0 bytes) and not descended into, so no cycle or escape is possible.
 * Individual readdir/stat failures are swallowed and mark the result partial rather than
 * voiding the whole walk.
 */
async function walk(root: string, limits: WalkLimits): Promise<WalkAccum> {
  const acc: WalkAccum = { bytes: 0, fileCount: 0, symlinkCount: 0, entries: 0, partial: false };
  const limiter = createLimiter(32);

  const visitDir = async (dir: string, depth: number): Promise<void> => {
    if (acc.entries >= limits.maxEntries) {
      acc.partial = true;
      return;
    }
    if (depth > limits.maxDepth) {
      acc.partial = true;
      return;
    }
    if (Date.now() > limits.deadline) {
      acc.partial = true;
      return;
    }
    let dirents;
    try {
      dirents = await limiter(() => readdir(dir, { withFileTypes: true }));
    } catch {
      acc.partial = true;
      return;
    }
    const tasks: Promise<void>[] = [];
    for (const dirent of dirents) {
      if (acc.entries >= limits.maxEntries) {
        acc.partial = true;
        break;
      }
      acc.entries += 1;
      const full = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        acc.symlinkCount += 1;
        continue;
      }
      if (dirent.isDirectory()) {
        tasks.push(visitDir(full, depth + 1));
        continue;
      }
      if (dirent.isFile()) {
        tasks.push(
          (async () => {
            try {
              const fileStats = await limiter(() => lstat(full));
              acc.bytes += fileStats.size;
              acc.fileCount += 1;
            } catch {
              acc.partial = true;
            }
          })(),
        );
        continue;
      }
      // socket, fifo, block/char device: counted as an entry above, contributes 0 bytes.
    }
    await Promise.all(tasks);
  };

  await visitDir(root, 0);
  return acc;
}

export interface MeasureOptions {
  /** In-memory cache, shared across calls, keyed by (dev, ino, mtimeMs) of the root. */
  cache?: MeasureCache;
  /** Overrides the default 2,000,000 entry cap; mainly for tests. */
  maxEntries?: number;
}

export async function measureTree(target: string, options: MeasureOptions = {}): Promise<TreeStats> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) throw new Error("reparse-point");
  const resolvedTarget = await safeRealPath(target);
  if (!resolvedTarget) throw new Error("reparse-point");
  if (!stats.isDirectory()) {
    return { bytes: stats.size, fileCount: 1, symlinkCount: 0, partial: false, fingerprint: fingerprintFromStats(stats) };
  }
  const cacheKey = measureCacheKey(stats);
  const cached = options.cache?.get(cacheKey);
  if (cached) return cached;
  const result = await walk(resolvedTarget, { maxEntries: options.maxEntries ?? measureEntryCap, maxDepth: Infinity, deadline: Infinity });
  const treeStats: TreeStats = {
    bytes: result.bytes,
    fileCount: result.fileCount,
    symlinkCount: result.symlinkCount,
    partial: result.partial,
    fingerprint: fingerprintFromStats(stats),
  };
  options.cache?.set(cacheKey, treeStats);
  return treeStats;
}

export async function approximateTree(
  target: string,
  limits?: { maxEntries?: number; maxDepth?: number; budgetMs?: number },
): Promise<{ bytes: number; fileCount: number; complete: boolean }> {
  const stats = await lstat(target).catch(() => undefined);
  if (!stats || stats.isSymbolicLink()) return { bytes: 0, fileCount: 0, complete: true };
  if (!stats.isDirectory()) return { bytes: stats.size, fileCount: 1, complete: true };
  const resolved = await safeRealPath(target);
  if (!resolved) return { bytes: 0, fileCount: 0, complete: true };
  const result = await walk(resolved, {
    maxEntries: limits?.maxEntries ?? 200_000,
    maxDepth: limits?.maxDepth ?? 6,
    deadline: Date.now() + (limits?.budgetMs ?? 1500),
  });
  return { bytes: result.bytes, fileCount: result.fileCount, complete: !result.partial };
}

export async function immediateChildren(target: string): Promise<string[]> {
  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
  const resolved = await safeRealPath(target);
  if (!resolved) return [];
  return (await readdir(resolved)).map((entry) => path.join(target, entry));
}

export async function filesUnder(target: string, include: (file: string) => boolean, excludedNames = new Set<string>()): Promise<string[]> {
  const output: string[] = [];
  let entries = 0;
  const visit = async (current: string): Promise<void> => {
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) return;
    const resolved = await safeRealPath(current);
    if (!resolved || !samePath(resolved, current)) return;
    if (!stats.isDirectory()) {
      if (include(current)) output.push(current);
      return;
    }
    for (const child of await readdir(current)) {
      if (excludedNames.has(child)) continue;
      entries += 1;
      if (entries > maxEntries) return;
      await visit(path.join(current, child));
    }
  };
  await visit(target);
  return output;
}

export async function removeTree(target: string): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) throw new Error("refusing-reparse-point");
  const resolved = await safeRealPath(target);
  if (!resolved || !samePath(resolved, target)) throw new Error("refusing-reparse-point");
  await rm(target, { recursive: stats.isDirectory(), force: false, maxRetries: 3, retryDelay: 50 });
}

export async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

export async function validateTarget(target: string, root: string): Promise<boolean> {
  return await isSafePath(target, root);
}
