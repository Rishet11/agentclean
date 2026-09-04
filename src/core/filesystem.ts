import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fingerprintFromStats, type Fingerprint } from "./types.js";
import { isSafePath, safeRealPath, samePath } from "./paths.js";

export interface TreeStats {
  bytes: number;
  fileCount: number;
  fingerprint: Fingerprint;
}

const maxEntries = 250_000;

export async function measureTree(target: string): Promise<TreeStats> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) throw new Error("reparse-point");
  const resolvedTarget = await safeRealPath(target);
  if (!resolvedTarget) throw new Error("reparse-point");
  if (!stats.isDirectory()) return { bytes: stats.size, fileCount: 1, fingerprint: fingerprintFromStats(stats) };
  let bytes = 0;
  let fileCount = 0;
  let entries = 0;
  const visit = async (current: string): Promise<void> => {
    const currentStats = await lstat(current);
    if (currentStats.isSymbolicLink()) throw new Error("reparse-point");
    const resolved = await safeRealPath(current);
    if (!resolved || !samePath(resolved, current)) throw new Error("reparse-point");
    if (!currentStats.isDirectory()) {
      bytes += currentStats.size;
      fileCount += 1;
      return;
    }
    const children = await readdir(current);
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) throw new Error("scan-limit");
      await visit(path.join(current, child));
    }
  };
  await visit(resolvedTarget);
  return { bytes, fileCount, fingerprint: fingerprintFromStats(stats) };
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
