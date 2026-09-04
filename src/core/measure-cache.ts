import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Fingerprint } from "./types.js";
import type { MeasureCache, TreeStats } from "./filesystem.js";

/**
 * Persisted measurement cache: the in-memory `MeasureCache` from filesystem.ts
 * saved to (and loaded from) a JSON file, so a second `scan` does not pay for
 * the same `lstat`-per-file walk of `~/.cache/uv`, `~/.npm`, project
 * `node_modules` trees, and git worktrees all over again.
 *
 * Key: `measureCacheKey(stats)` = `dev:ino:mtimeMs` of the *root* directory
 * being measured (see filesystem.ts). This invalidates naturally the moment
 * an entry is added, removed, or renamed directly under that root, because
 * that is exactly what bumps a directory's own mtime on POSIX filesystems.
 *
 * What it does NOT catch: content that changed further down the tree without
 * ever touching a directory's own entries (e.g. a file rewritten in place, or
 * a same-size in-place edit two levels down). That mtime is invisible to the
 * root's cache key. We accept this: the categories this cache actually helps
 * (package-manager caches that add/remove entries on every install/prune,
 * node_modules that changes its own top-level entries on any dependency add
 * or remove, and worktrees that change directory entries on nearly every git
 * operation) all bump *something* on the path the tool measures in normal use.
 * The residual risk is bounded further by `maxAgeMs` below, so a stale entry
 * cannot survive indefinitely even if nothing ever touches the directory.
 *
 * This is a reporting-time optimisation only: `src/core/scan.ts` sets this
 * cache as the shared cache only around `discover()` and clears it before
 * returning, so `revalidate()` (the safety check right before a delete) never
 * sees it and always re-measures from scratch.
 */

const schemaVersion = 1;
const maxEntries = 5_000;
const maxAgeMs = 14 * 24 * 60 * 60 * 1000; // 14 days: bounds staleness for a directory that never changes its own entries.

interface PersistedEntry {
  bytes: number;
  fileCount: number;
  symlinkCount: number;
  partial: boolean;
  fingerprint: Fingerprint;
  childCount?: number;
  savedAt: number;
}

interface PersistedFile {
  schemaVersion: number;
  entries: Record<string, PersistedEntry>;
}

export function measureCacheFilePath(runDir: string): string {
  return path.join(runDir, "measure-cache.json");
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (!value || typeof value !== "object") return false;
  const fingerprint = value as Partial<Fingerprint>;
  return (fingerprint.kind === "file" || fingerprint.kind === "directory") && typeof fingerprint.size === "number" && typeof fingerprint.mtimeMs === "number";
}

function isPersistedEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PersistedEntry>;
  return (
    typeof entry.bytes === "number" &&
    typeof entry.fileCount === "number" &&
    typeof entry.symlinkCount === "number" &&
    typeof entry.partial === "boolean" &&
    typeof entry.savedAt === "number" &&
    (entry.childCount === undefined || typeof entry.childCount === "number") &&
    isFingerprint(entry.fingerprint)
  );
}

export interface PersistedMeasureCache {
  cache: MeasureCache;
  /** True if any entry was read back (used by tests/diagnostics; save() persists whatever is currently in the cache regardless). */
  loadedEntries: number;
  /** Writes the current contents back to disk, capped and atomically. Never throws: a cache is an optimisation, not a dependency. */
  save(): Promise<void>;
}

/**
 * Loads the persisted cache from `<runDir>/measure-cache.json`. A missing,
 * unreadable, corrupt, or schema-mismatched file degrades silently to an
 * empty cache — never fails the caller. Individually malformed entries are
 * dropped rather than voiding the whole file.
 */
export async function loadMeasureCache(runDir: string): Promise<PersistedMeasureCache> {
  const entries = new Map<string, PersistedEntry>();
  let loadedEntries = 0;
  try {
    const raw = await readFile(measureCacheFilePath(runDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedFile>;
    if (parsed.schemaVersion === schemaVersion && parsed.entries && typeof parsed.entries === "object") {
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (isPersistedEntry(value)) entries.set(key, value);
      }
      loadedEntries = entries.size;
    }
  } catch {
    // Missing file, invalid JSON, wrong schema version: start cold. Never throw.
  }

  const now = Date.now();
  const cache: MeasureCache = {
    get: (key) => {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now - entry.savedAt > maxAgeMs) {
        entries.delete(key);
        return undefined;
      }
      const { savedAt: _savedAt, ...stats } = entry;
      return stats as TreeStats;
    },
    set: (key, value) => {
      entries.set(key, { ...value, savedAt: Date.now() });
    },
  };

  return {
    cache,
    loadedEntries,
    save: () => saveMeasureCache(runDir, entries),
  };
}

async function saveMeasureCache(runDir: string, entries: Map<string, PersistedEntry>): Promise<void> {
  try {
    await mkdir(runDir, { recursive: true });
    // Bound the file: keep the most recently written entries, evict the rest.
    const bounded = [...entries.entries()].sort((left, right) => right[1].savedAt - left[1].savedAt).slice(0, maxEntries);
    const payload: PersistedFile = { schemaVersion, entries: Object.fromEntries(bounded) };
    const target = measureCacheFilePath(runDir);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, target).catch(async (error) => {
      // Best-effort cleanup of the temp file if the rename itself failed.
      await unlink(tmp).catch(() => {});
      throw error;
    });
  } catch {
    // A cache write failure must never fail a scan.
  }
}

/**
 * Drop the persisted cache entirely.
 *
 * The cache keys on the root's (dev, ino, mtimeMs). A directory's mtime only
 * moves when its own immediate entries change, so a prune that deletes files
 * deep inside leaves the root looking untouched. Measured after a real run:
 * `uv cache prune` took ~/.cache/uv from 10.06 GB to 1.9 GB and `pnpm store
 * prune` took the pnpm store to zero, while the next scan still advertised
 * 10.06 GB and 1.12 GB from cache.
 *
 * Advertising space that is already gone is the one number this tool cannot
 * get wrong, so any run that actually changed something discards the cache and
 * pays for one honest re-measure next time.
 */
export async function invalidateMeasureCache(runDir: string): Promise<void> {
  await rm(measureCacheFilePath(runDir), { force: true }).catch(() => undefined);
}
