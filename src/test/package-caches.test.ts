import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandProvider } from "../providers/command.js";
import { bunProvider, goProvider, parseCachePath, pipProvider, uvProvider, yarnProvider } from "../providers/package-caches.js";

test("detect() reports unavailable for a tool that does not exist", async () => {
  const provider = new CommandProvider("nope", "Nonexistent Tool", ["definitely-not-a-real-binary-xyz123", "cache", "dir"], ["definitely-not-a-real-binary-xyz123", "cache", "prune"], "fake cache", false);
  const detection = await provider.detect();
  assert.equal(detection.status, "unavailable");
  assert.deepEqual(await provider.discover(), []);
});

// yarn and bun are not installed on this machine (only uv and go are, besides
// npm/pnpm), so detect() reporting "unavailable" without throwing is the one
// path actually exercisable here for them. Their cleanup argv is asserted
// directly off the constructed instance instead: `cleanupCommand` is a TS
// "private" constructor-property, which is a compile-time-only restriction —
// at runtime it is a normal own property, so this reads it without running
// anything. pip *is* installed (as pip3), so its test below exercises the
// live discover() path like the uv/go tests further down.

test("yarn provider's detect() reports unavailable when yarn is absent, without throwing", async () => {
  const detection = await yarnProvider().detect();
  if (detection.status !== "unavailable") { assert.equal(detection.status, "verified"); return; } // yarn installed on this runner
  assert.equal(detection.status, "unavailable");
  assert.deepEqual(await yarnProvider().discover(), []);
});

test("yarn provider's cleanup command is exactly 'yarn cache clean'", () => {
  const cleanupCommand = (yarnProvider() as unknown as { cleanupCommand: string[] }).cleanupCommand;
  assert.deepEqual(cleanupCommand, ["yarn", "cache", "clean"]);
});

test("bun provider's detect() reports unavailable when bun is absent, without throwing", async () => {
  const detection = await bunProvider().detect();
  if (detection.status !== "unavailable") { assert.equal(detection.status, "verified"); return; } // bun installed on this runner
  assert.equal(detection.status, "unavailable");
  assert.deepEqual(await bunProvider().discover(), []);
});

test("bun provider's cleanup command is exactly 'bun pm cache rm'", () => {
  const cleanupCommand = (bunProvider() as unknown as { cleanupCommand: string[] }).cleanupCommand;
  assert.deepEqual(cleanupCommand, ["bun", "pm", "cache", "rm"]);
});

test("pip provider's detect() reports verified when pip3 is on PATH, unavailable otherwise", async (t) => {
  const detection = await pipProvider().detect();
  if (detection.status === "unavailable") { t.skip("pip3 not installed on this machine"); return; }
  // pip3 is confirmed installed on this dev machine (see report), so this is
  // the branch actually exercised here. The "tool absent" code path is the
  // same CommandProvider.detect() logic already covered by the synthetic
  // "nope" tool test at the top of this file and the yarn/bun tests above.
  assert.equal(detection.status, "verified");
});

test("pip provider's cleanup command is exactly 'pip3 cache purge'", async (t) => {
  const candidates = await pipProvider().discover();
  if (candidates.length === 0) { t.skip("pip3 not installed on this machine"); return; }
  const [candidate] = candidates;
  assert.equal(candidate.target.kind, "command");
  if (candidate.target.kind === "command") assert.deepEqual(candidate.target.command, ["pip3", "cache", "purge"]);
});

// Points each tool's cache at a small, symlink-free temp directory via the
// tool's own env override (UV_CACHE_DIR / GOMODCACHE) so discover()'s real
// `uv cache dir` / `go env GOMODCACHE` calls succeed and measureTree does not
// trip over the real caches' symlinks (a known, out-of-scope bug elsewhere).
// The cleanup commands (`uv cache prune`, `go clean -modcache`) are read off
// the resulting candidate and never invoked. discover() runs the path-lookup
// command directly rather than gating on detect() — detect()'s `<tool>
// --version` probe is unreliable for go, which has no --version flag (see
// report), so gate on discover() actually finding the tool instead.

test("uv provider's cleanup command is exactly 'uv cache prune'", async (t) => {
  const uvCacheDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-uv-cache-"));
  await writeFile(path.join(uvCacheDir, "marker"), "x");
  const previous = process.env.UV_CACHE_DIR;
  process.env.UV_CACHE_DIR = uvCacheDir;
  let candidates;
  try {
    candidates = await uvProvider().discover();
  } finally {
    if (previous === undefined) delete process.env.UV_CACHE_DIR; else process.env.UV_CACHE_DIR = previous;
  }
  if (candidates.length === 0) { t.skip("uv not installed on this machine"); return; }
  const [candidate] = candidates;
  assert.equal(candidate.target.kind, "command");
  if (candidate.target.kind === "command") assert.deepEqual(candidate.target.command, ["uv", "cache", "prune"]);
});

test("go provider's cleanup command is exactly 'go clean -modcache'", async (t) => {
  const goModCacheDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-go-modcache-"));
  await writeFile(path.join(goModCacheDir, "marker"), "x");
  const previous = process.env.GOMODCACHE;
  process.env.GOMODCACHE = goModCacheDir;
  let candidates;
  try {
    candidates = await goProvider().discover();
  } finally {
    if (previous === undefined) delete process.env.GOMODCACHE; else process.env.GOMODCACHE = previous;
  }
  if (candidates.length === 0) { t.skip("go not installed on this machine"); return; }
  const [candidate] = candidates;
  assert.equal(candidate.target.kind, "command");
  if (candidate.target.kind === "command") assert.deepEqual(candidate.target.command, ["go", "clean", "-modcache"]);
});

test("parseCachePath takes the last absolute-looking line, not blindly the last line", () => {
  assert.equal(parseCachePath("/Users/example/.cache/uv\n"), "/Users/example/.cache/uv");
  assert.equal(parseCachePath("warning: something\n/Users/example/.cache/uv"), "/Users/example/.cache/uv");
  assert.equal(parseCachePath("/Users/example/.cache/uv\nwarning: trailing note"), "/Users/example/.cache/uv");
  assert.equal(parseCachePath("just some text with no path"), "just some text with no path");
});
