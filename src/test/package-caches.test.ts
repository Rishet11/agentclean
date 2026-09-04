import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandProvider } from "../providers/command.js";
import { goProvider, parseCachePath, uvProvider } from "../providers/package-caches.js";

test("detect() reports unavailable for a tool that does not exist", async () => {
  const provider = new CommandProvider("nope", "Nonexistent Tool", ["definitely-not-a-real-binary-xyz123", "cache", "dir"], ["definitely-not-a-real-binary-xyz123", "cache", "prune"], "fake cache", false);
  const detection = await provider.detect();
  assert.equal(detection.status, "unavailable");
  assert.deepEqual(await provider.discover(), []);
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
