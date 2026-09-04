import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approximateTree,
  createMeasureCache,
  getSharedMeasureCache,
  measureCacheKey,
  measureTree,
  peekMeasureCache,
  setSharedMeasureCache,
  type MeasureCache,
  type TreeStats,
} from "../core/filesystem.js";

// os.tmpdir() is itself under a symlink on macOS (/var -> /private/var); measureTree
// canonicalizes its root, so fixtures must already be canonical or path comparisons
// inside the walk (and the outside-root test below) would be comparing apples to oranges.
async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

test("measures real files, reports symlinkCount, and never follows a symlink", async () => {
  const root = await tempDir("agentclean-measure-");
  await writeFile(path.join(root, "small.txt"), "x".repeat(37));
  await mkdir(path.join(root, "pkg"));
  const largePayload = Buffer.alloc(3_000_000, 1);
  await writeFile(path.join(root, "pkg", "large.bin"), largePayload);
  await mkdir(path.join(root, ".bin"));
  // node_modules/.bin shape: a symlink into a sibling package directory.
  await symlink(path.join("..", "pkg", "large.bin"), path.join(root, ".bin", "link"));

  const smallStat = await stat(path.join(root, "small.txt"));
  const largeStat = await stat(path.join(root, "pkg", "large.bin"));
  const expectedBytes = smallStat.size + largeStat.size;

  const result = await measureTree(root);
  // If the symlink were followed, large.bin would be counted twice.
  assert.equal(result.bytes, expectedBytes);
  assert.equal(result.fileCount, 2);
  assert.equal(result.symlinkCount, 1);
  assert.equal(result.partial, false);
});

test("a symlink pointing outside the root is not followed", async () => {
  const root = await tempDir("agentclean-measure-outside-");
  const outside = await tempDir("agentclean-measure-outside-target-");
  await writeFile(path.join(outside, "big.bin"), Buffer.alloc(2_000_000, 2));
  await writeFile(path.join(root, "inside.txt"), "hello");
  await symlink(outside, path.join(root, "link"));

  const insideStat = await stat(path.join(root, "inside.txt"));
  const result = await measureTree(root);
  assert.equal(result.bytes, insideStat.size);
  assert.equal(result.fileCount, 1);
  assert.equal(result.symlinkCount, 1);
});

test("a symlink cycle terminates without hanging", async () => {
  const root = await tempDir("agentclean-measure-cycle-");
  await mkdir(path.join(root, "a"));
  await symlink(path.join(root, "a"), path.join(root, "a", "link"));

  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 5_000));
  const result = await Promise.race([measureTree(root), timeout]);
  assert.equal(result.symlinkCount, 1);
  assert.equal(result.bytes, 0);
});

test("the entry cap sets partial instead of throwing", async () => {
  const root = await tempDir("agentclean-measure-cap-");
  for (let i = 0; i < 10; i += 1) await writeFile(path.join(root, `f${i}.txt`), "x");

  const result = await measureTree(root, { maxEntries: 5 });
  assert.equal(result.partial, true);
  assert.ok(result.fileCount <= 5);
});

test("approximateTree stops at a bound and reports incomplete", async () => {
  const root = await tempDir("agentclean-approx-");
  for (let i = 0; i < 50; i += 1) await writeFile(path.join(root, `f${i}.txt`), "x".repeat(10));

  const result = await approximateTree(root, { maxEntries: 10 });
  assert.equal(result.complete, false);
  assert.ok(result.bytes > 0);
  assert.ok(result.bytes <= 500);
});

test("the measure cache returns a cached result without re-walking", async () => {
  const root = await tempDir("agentclean-cache-");
  await writeFile(path.join(root, "a.txt"), "hello");

  let gets = 0;
  let sets = 0;
  const store = new Map<string, TreeStats>();
  const cache: MeasureCache = {
    get: (key) => {
      gets += 1;
      return store.get(key);
    },
    set: (key, value) => {
      sets += 1;
      store.set(key, value);
    },
  };

  const first = await measureTree(root, { cache });
  const second = await measureTree(root, { cache });

  assert.deepEqual(second, first);
  assert.equal(gets, 2);
  assert.equal(sets, 1);

  // Same key derives from (dev, ino, mtimeMs) of the root, independent of the walk.
  const rootStats = await stat(root);
  assert.equal(measureCacheKey(rootStats), measureCacheKey(rootStats));
});

test("a cache hit is re-validated with a single readdir and a top-level add invalidates it even if the stale entry lost its own childCount", async () => {
  const root = await tempDir("agentclean-childcount-");
  await writeFile(path.join(root, "a.txt"), "hello");

  const store = new Map<string, TreeStats>();
  const cache: MeasureCache = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };

  const first = await measureTree(root, { cache });
  assert.equal(first.childCount, 1);

  // Forge a stale entry under the *same* key but without a childCount, simulating
  // an older cache format: measureTree must trust it (nothing to check against).
  const key = measureCacheKey(await stat(root));
  store.set(key, { ...first, childCount: undefined });
  const trusted = await measureTree(root, { cache });
  assert.deepEqual(trusted, { ...first, childCount: undefined });

  // Restore a real childCount, then forge a mismatch: measureTree must not
  // trust it and should re-walk, discovering the file added below.
  store.set(key, { ...first, childCount: 99 });
  await writeFile(path.join(root, "b.txt"), "world");
  const revalidated = await measureTree(root, { cache });
  assert.equal(revalidated.fileCount, 2);
  assert.equal(revalidated.childCount, 2);
});

test("measureTree falls back to the shared cache when no explicit cache is passed, and never touches it once cleared", async () => {
  const root = await tempDir("agentclean-shared-cache-");
  await writeFile(path.join(root, "a.txt"), "hello");

  assert.equal(getSharedMeasureCache(), undefined);
  const shared = createMeasureCache();
  setSharedMeasureCache(shared);
  try {
    const first = await measureTree(root);
    const second = await measureTree(root);
    assert.deepEqual(second, first);
    assert.equal(shared.get(measureCacheKey(await stat(root))) !== undefined, true);
  } finally {
    setSharedMeasureCache(undefined);
  }

  // Cleared: a fresh directory with the exact same size profile must not
  // accidentally read back anything from the now-detached shared cache.
  assert.equal(getSharedMeasureCache(), undefined);
});

test("peekMeasureCache never walks: it returns undefined on a miss instead of measuring", async () => {
  const root = await tempDir("agentclean-peek-");
  await writeFile(path.join(root, "a.txt"), "hello");
  const cache = createMeasureCache();

  assert.equal(await peekMeasureCache(root, cache), undefined);

  const measured = await measureTree(root, { cache });
  const peeked = await peekMeasureCache(root, cache);
  assert.deepEqual(peeked, measured);

  // A top-level change invalidates the peek the same way it invalidates measureTree.
  await writeFile(path.join(root, "b.txt"), "world");
  assert.equal(await peekMeasureCache(root, cache), undefined);
});

test("approximateTree reports symlinkCount and childCount alongside bytes", async () => {
  const root = await tempDir("agentclean-approx-fields-");
  await writeFile(path.join(root, "a.txt"), "x".repeat(10));
  await mkdir(path.join(root, "sub"));
  await symlink(path.join(root, "a.txt"), path.join(root, "link"));

  const result = await approximateTree(root, { budgetMs: 5_000 });
  assert.equal(result.complete, true);
  assert.equal(result.symlinkCount, 1);
  // root has: a.txt, sub, link
  assert.equal(result.childCount, 3);
});
