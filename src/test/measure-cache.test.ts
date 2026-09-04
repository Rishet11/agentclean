import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invalidateMeasureCache, loadMeasureCache, measureCacheFilePath } from "../core/measure-cache.js";
import { measureCacheKey, type TreeStats } from "../core/filesystem.js";

async function tempRunDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentclean-measure-cache-"));
}

const sampleStats: TreeStats = {
  bytes: 123,
  fileCount: 4,
  symlinkCount: 0,
  partial: false,
  fingerprint: { kind: "directory", size: 0, mtimeMs: 1_700_000_000_000, dev: 1, ino: 2 },
  childCount: 3,
};

test("round-trips an entry through save and a fresh load", async () => {
  const runDir = await tempRunDir();
  const { cache, save } = await loadMeasureCache(runDir);
  cache.set("key-1", sampleStats);
  await save();

  const reloaded = await loadMeasureCache(runDir);
  assert.deepEqual(reloaded.cache.get("key-1"), sampleStats);
  assert.equal(reloaded.loadedEntries, 1);
});

test("a missing cache file loads as empty rather than throwing", async () => {
  const runDir = await tempRunDir();
  const loaded = await loadMeasureCache(runDir);
  assert.equal(loaded.cache.get("anything"), undefined);
  assert.equal(loaded.loadedEntries, 0);
});

test("a corrupt (non-JSON) cache file degrades to empty instead of failing the scan", async () => {
  const runDir = await tempRunDir();
  await writeFile(measureCacheFilePath(runDir), "{ not valid json at all", "utf8");
  const loaded = await loadMeasureCache(runDir);
  assert.equal(loaded.cache.get("anything"), undefined);
  assert.equal(loaded.loadedEntries, 0);
  // And it must still be possible to use and save a fresh cache afterward.
  loaded.cache.set("key-1", sampleStats);
  await loaded.save();
  const reloaded = await loadMeasureCache(runDir);
  assert.deepEqual(reloaded.cache.get("key-1"), sampleStats);
});

test("a schema version mismatch invalidates the whole file rather than misreading it", async () => {
  const runDir = await tempRunDir();
  await writeFile(measureCacheFilePath(runDir), JSON.stringify({ schemaVersion: 999, entries: { "key-1": { ...sampleStats, savedAt: Date.now() } } }), "utf8");
  const loaded = await loadMeasureCache(runDir);
  assert.equal(loaded.cache.get("key-1"), undefined);
  assert.equal(loaded.loadedEntries, 0);
});

test("a malformed individual entry is dropped without discarding the rest of the file", async () => {
  const runDir = await tempRunDir();
  await writeFile(
    measureCacheFilePath(runDir),
    JSON.stringify({
      schemaVersion: 1,
      entries: {
        good: { ...sampleStats, savedAt: Date.now() },
        bad: { bytes: "not-a-number" },
        alsoBad: null,
      },
    }),
    "utf8",
  );
  const loaded = await loadMeasureCache(runDir);
  assert.deepEqual(loaded.cache.get("good"), sampleStats);
  assert.equal(loaded.cache.get("bad"), undefined);
  assert.equal(loaded.loadedEntries, 1);
});

test("an entry older than the max age is treated as expired", async () => {
  const runDir = await tempRunDir();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  await writeFile(
    measureCacheFilePath(runDir),
    JSON.stringify({
      schemaVersion: 1,
      entries: {
        stale: { ...sampleStats, savedAt: Date.now() - fourteenDaysMs - 1 },
        fresh: { ...sampleStats, savedAt: Date.now() },
      },
    }),
    "utf8",
  );
  const loaded = await loadMeasureCache(runDir);
  assert.equal(loaded.cache.get("stale"), undefined);
  assert.deepEqual(loaded.cache.get("fresh"), sampleStats);
});

test("save() writes atomically: no leftover temp file, and the target is always valid JSON", async () => {
  const runDir = await tempRunDir();
  const { cache, save } = await loadMeasureCache(runDir);
  cache.set("key-1", sampleStats);
  await save();

  const files = await readdir(runDir);
  assert.deepEqual(files, ["measure-cache.json"]);
  const parsed = JSON.parse(await readFile(measureCacheFilePath(runDir), "utf8"));
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.entries["key-1"]);
});

test("save() bounds the file: beyond the cap, the newest entries survive and the oldest are evicted", async () => {
  const runDir = await tempRunDir();
  const { cache, save } = await loadMeasureCache(runDir);

  for (let i = 0; i < 3_000; i += 1) cache.set(`old-${i}`, sampleStats);
  // Force a distinct, strictly later savedAt for the second batch.
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 3_000; i += 1) cache.set(`new-${i}`, sampleStats);

  await save();
  const parsed = JSON.parse(await readFile(measureCacheFilePath(runDir), "utf8")) as { entries: Record<string, unknown> };
  const keys = Object.keys(parsed.entries);
  assert.equal(keys.length, 5_000);
  // Every entry from the strictly-newer second batch (3,000 of them) must have
  // survived; only entries from the older first batch (3,000) can be among
  // the 1,000 evicted to stay under the cap.
  for (let i = 0; i < 3_000; i += 1) assert.ok(`new-${i}` in parsed.entries, `new-${i} should have survived eviction`);
});

test("wires into measureTree's shared cache the same way scan.ts does: warm on a second call, keyed by (dev, ino, mtimeMs)", async () => {
  const { measureTree, setSharedMeasureCache } = await import("../core/filesystem.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "agentclean-measure-cache-integration-"));
  await writeFile(path.join(root, "a.txt"), "hello");
  const runDir = await tempRunDir();

  const first = await loadMeasureCache(runDir);
  setSharedMeasureCache(first.cache);
  const measured = await measureTree(root);
  setSharedMeasureCache(undefined);
  await first.save();

  const second = await loadMeasureCache(runDir);
  const rootStats = await stat(root);
  assert.deepEqual(second.cache.get(measureCacheKey(rootStats)), measured);
});

test("a run that freed space discards the cache, so the next scan cannot advertise it", async () => {
  // Regression from a real run: `uv cache prune` took ~/.cache/uv from 10.06 GB
  // to 1.9 GB and `pnpm store prune` emptied the pnpm store, but neither
  // changed its root directory's mtime, so the next scan served both from
  // cache and offered 11 GB that no longer existed.
  const runDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-invalidate-")));
  try {
    const cache = await loadMeasureCache(runDir);
    cache.cache.set("dev:ino:mtime", { bytes: 10_060_000_000, fileCount: 122_313, symlinkCount: 0, partial: false, fingerprint: { kind: "directory", size: 0, mtimeMs: 1 } });
    await cache.save();
    assert.ok(existsSync(measureCacheFilePath(runDir)), "cache file should exist before invalidation");

    await invalidateMeasureCache(runDir);
    assert.equal(existsSync(measureCacheFilePath(runDir)), false, "a freeing run must discard the cache");

    const reloaded = await loadMeasureCache(runDir);
    assert.equal(reloaded.cache.get("dev:ino:mtime"), undefined, "stale size must not survive");
    await invalidateMeasureCache(runDir); // idempotent, must not throw
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
