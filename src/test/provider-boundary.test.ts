import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemProvider } from "../providers/filesystem.js";
import type { ExecuteContext } from "../core/types.js";

function context(root: string): ExecuteContext {
  return {
    now: Date.now(),
    roots: [root],
    configRoots: [],
    cwd: root,
    home: root,
    env: {},
    policy: { version: 1, safeCacheAgeDays: 30, historyAgeDays: 90, worktreeInactiveDays: 30, autoCategories: [], autoProviders: [], worktreeRoots: [] },
    dryRun: false,
    runDir: root,
  };
}

test("filesystem provider only exposes disposable direct children", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentclean-provider-"));
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot);
  const old = path.join(cacheRoot, "old");
  const protectedEntry = path.join(cacheRoot, "settings.json");
  await mkdir(old);
  await writeFile(path.join(old, "data.bin"), "data");
  await writeFile(protectedEntry, "settings");
  const oldTime = new Date(Date.now() - 60 * 86_400_000);
  await utimes(old, oldTime, oldTime);
  const provider = new FilesystemProvider("test", "Test", () => root, [{ relativePath: "cache", category: "ai-caches", reason: "test cache", autoSafe: true, minAgeDays: 30 }], new Set(["settings.json"]));
  const candidates = await provider.discover(context(root));
  assert.deepEqual(candidates.map((candidate) => path.basename(candidate.target.kind === "path" ? candidate.target.path : "")), ["old"]);
  const candidate = candidates[0];
  assert.ok(candidate);
  assert.equal((await provider.revalidate({ ...candidate, target: { kind: "path", path: cacheRoot } }, context(root))).ok, false);
});
