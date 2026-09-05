import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandProvider } from "../providers/command.js";
import { bunProvider, cargoProvider, goProvider, gradleProvider, parseCachePath, pipProvider, uvProvider, yarnProvider } from "../providers/package-caches.js";
import type { Candidate, ExecuteContext } from "../core/types.js";

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

// ---------------------------------------------------------------------------
// cargo / gradle — env-var root + fixed documented-safe subdirectories,
// deleted directly (no provider command exists for either — see the
// package-caches.ts file header for the research this is built on).
// ---------------------------------------------------------------------------

async function tmpDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

function context(home: string, env: NodeJS.ProcessEnv = {}): ExecuteContext {
  return {
    now: Date.now(),
    roots: [home],
    configRoots: [],
    cwd: home,
    home,
    env,
    policy: { version: 1, safeCacheAgeDays: 30, historyAgeDays: 90, worktreeInactiveDays: 30, autoCategories: [], autoProviders: [], worktreeRoots: [] },
    dryRun: false,
    runDir: home,
  };
}

function pkgTargetPath(candidate: Candidate): string {
  return candidate.target.kind === "path" ? candidate.target.path : "";
}

test("cargo: CARGO_HOME override finds all four documented subdirectories as separate eligible candidates", async () => {
  const home = await tmpDir("agentclean-cargo-home-");
  const cargoHome = await tmpDir("agentclean-cargo-override-");
  for (const segments of [["registry", "cache"], ["registry", "src"], ["git", "db"], ["git", "checkouts"]]) {
    await mkdir(path.join(cargoHome, ...segments), { recursive: true });
    await writeFile(path.join(cargoHome, ...segments, "entry"), "x".repeat(20));
  }
  const candidates = await cargoProvider().discover(context(home, { CARGO_HOME: cargoHome }));
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((c) => c.category === "package-caches" && c.eligible === true && c.blockers.length === 0 && c.autoSafe === false));
  assert.ok(candidates.every((c) => pkgTargetPath(c).startsWith(cargoHome)));
  const relPaths = new Set(candidates.map((c) => path.relative(cargoHome, pkgTargetPath(c))));
  assert.deepEqual(relPaths, new Set([path.join("registry", "cache"), path.join("registry", "src"), path.join("git", "db"), path.join("git", "checkouts")]));
});

test("cargo: falls back to ~/.cargo when CARGO_HOME is unset, and missing subdirectories contribute nothing", async () => {
  const home = await tmpDir("agentclean-cargo-default-");
  await mkdir(path.join(home, ".cargo", "registry", "cache"), { recursive: true });
  await writeFile(path.join(home, ".cargo", "registry", "cache", "entry"), "x".repeat(15));
  // registry/src, git/db, git/checkouts deliberately absent.
  const candidates = await cargoProvider().discover(context(home));
  assert.equal(candidates.length, 1);
  assert.ok(pkgTargetPath(candidates[0]).startsWith(path.join(home, ".cargo")));
  assert.equal(candidates[0].bytes, 15);
});

test("cargo: a symlinked cache subdirectory is never a candidate", async () => {
  const home = await tmpDir("agentclean-cargo-symlink-");
  const cargoHome = await tmpDir("agentclean-cargo-symlink-target-");
  const elsewhere = await tmpDir("agentclean-cargo-symlink-elsewhere-");
  await writeFile(path.join(elsewhere, "entry"), "x".repeat(50));
  await mkdir(path.join(cargoHome, "registry"), { recursive: true });
  await symlink(elsewhere, path.join(cargoHome, "registry", "cache"));
  const candidates = await cargoProvider().discover(context(home, { CARGO_HOME: cargoHome }));
  assert.deepEqual(candidates, []);
});

test("cargo: detect() reports verified with 'not present' when ~/.cargo does not exist, never 'unavailable'", async () => {
  const home = await tmpDir("agentclean-cargo-absent-");
  const detection = await cargoProvider().detect(context(home));
  assert.equal(detection.status, "verified");
  assert.equal(detection.root, undefined);
});

test("cargo: revalidate() + execute() actually remove a candidate, and reject one that changed size since scan", async () => {
  const home = await tmpDir("agentclean-cargo-delete-");
  const cargoHome = await tmpDir("agentclean-cargo-delete-target-");
  await mkdir(path.join(cargoHome, "registry", "cache"), { recursive: true });
  await writeFile(path.join(cargoHome, "registry", "cache", "entry"), "x".repeat(30));
  const ctx = context(home, { CARGO_HOME: cargoHome });
  const [candidate] = await cargoProvider().discover(ctx);
  assert.ok(candidate);

  // Mutate after scan, before revalidate: must be rejected, not deleted.
  // Adding a file changes the directory's own mtime, so this is caught by
  // the fingerprint check first (same ordering as FilesystemProvider).
  await writeFile(path.join(cargoHome, "registry", "cache", "entry2"), "y".repeat(10));
  const staleRevalidation = await cargoProvider().revalidate(candidate, ctx);
  assert.equal(staleRevalidation.ok, false);
  assert.equal(staleRevalidation.reason, "changed-since-scan");

  // Re-scan to get a fresh candidate matching current contents, then delete it for real.
  const [freshCandidate] = await cargoProvider().discover(ctx);
  const revalidation = await cargoProvider().revalidate(freshCandidate, ctx);
  assert.equal(revalidation.ok, true);
  const execution = await cargoProvider().execute(freshCandidate, ctx);
  assert.equal(execution.ok, true);
  assert.equal(execution.bytes, freshCandidate.bytes);
  await assert.rejects(() => readFile(path.join(cargoHome, "registry", "cache", "entry")));
});

test("gradle: GRADLE_USER_HOME override finds all four documented subdirectories as separate eligible candidates", async () => {
  const home = await tmpDir("agentclean-gradle-home-");
  const gradleHome = await tmpDir("agentclean-gradle-override-");
  for (const name of ["modules-2", "jars-9", "transforms-3", "build-cache-1"]) {
    await mkdir(path.join(gradleHome, "caches", name), { recursive: true });
    await writeFile(path.join(gradleHome, "caches", name, "entry"), "x".repeat(25));
  }
  const candidates = await gradleProvider().discover(context(home, { GRADLE_USER_HOME: gradleHome }));
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((c) => c.category === "package-caches" && c.eligible === true && c.autoSafe === false));
  const names = new Set(candidates.map((c) => path.basename(pkgTargetPath(c))));
  assert.deepEqual(names, new Set(["modules-2", "jars-9", "transforms-3", "build-cache-1"]));
});

test("gradle: falls back to ~/.gradle when GRADLE_USER_HOME is unset; a differently-versioned cache dir name is simply not found", async () => {
  const home = await tmpDir("agentclean-gradle-default-");
  await mkdir(path.join(home, ".gradle", "caches", "modules-2"), { recursive: true });
  await writeFile(path.join(home, ".gradle", "caches", "modules-2", "entry"), "x".repeat(12));
  // Simulates a different Gradle release: this machine's real ~/.gradle (see
  // report) has no caches/ directory at all, just android/daemon/jdks/etc.
  await mkdir(path.join(home, ".gradle", "android"), { recursive: true });
  await writeFile(path.join(home, ".gradle", "android", "unrelated"), "not a documented entry");

  const candidates = await gradleProvider().discover(context(home));
  assert.equal(candidates.length, 1);
  assert.equal(path.basename(pkgTargetPath(candidates[0])), "modules-2");
  assert.ok(!candidates.some((c) => pkgTargetPath(c).includes("android")));
});
