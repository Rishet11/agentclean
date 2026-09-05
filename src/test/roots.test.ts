import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canRegisterRoot, discoverRoots } from "../core/roots.js";

test("discovers existing common dev directories, dedupes nested git repos, drops nested paths, and never throws on an unreadable directory", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-roots-")));

  // Present common dev directories.
  await mkdir(path.join(home, "Desktop"), { recursive: true });
  await mkdir(path.join(home, "dev"), { recursive: true });
  // Documents, src, code, projects, work, repos, git, Developer intentionally absent.

  // A git repo nested inside an already-discovered common dev directory: should
  // not appear as a separate entry once nested paths are dropped.
  const nestedRepo = path.join(home, "dev", "sub", "proj");
  await mkdir(nestedRepo, { recursive: true });
  await mkdir(path.join(nestedRepo, ".git"), { recursive: true });

  // A directory with no read/execute permission, to prove discovery never throws.
  const locked = path.join(home, "Desktop", "locked");
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o000);

  try {
    const roots = await discoverRoots({ home, cwd: home, env: {} });
    const desktop = await realpath(path.join(home, "Desktop"));
    const dev = await realpath(path.join(home, "dev"));

    assert.deepEqual(new Set(roots), new Set([desktop, dev]));
    assert.equal(roots.length, new Set(roots).size, "no duplicates");
    assert.equal(roots.some((root) => root !== dev && root.startsWith(`${dev}${path.sep}`)), false, "nested paths dropped");
    for (const name of ["Documents", "src", "code", "projects", "work", "repos", "git", "Developer"]) {
      assert.equal(roots.includes(path.join(home, name)), false, `absent directory ${name} not reported`);
    }
  } finally {
    await chmod(locked, 0o755).catch(() => {});
  }
});

test("never throws and returns an empty list when home does not exist", async () => {
  const missingHome = path.join(os.tmpdir(), "agentclean-roots-missing-", String(Date.now()));
  const roots = await discoverRoots({ home: missingHome, cwd: missingHome, env: {} });
  assert.deepEqual(roots, []);
});

// canRegisterRoot is pure and synchronous (no filesystem access), so every
// dangerous shape it must refuse -- and the legitimate shape it must allow --
// is testable directly against plain strings, no fixtures required. `home`
// has three segments below the filesystem root so an ancestor one level up
// ("/Users/alice") is distinguishable from both the root itself and a
// top-level OS directory.
const home = path.join(path.sep, "Users", "alice", "work");

const dangerousCases: Array<{ name: string; candidate: string; existingRoots?: string[] }> = [
  { name: "$HOME itself", candidate: home },
  { name: "the filesystem root", candidate: path.sep },
  { name: "a system directory unrelated to home (shallow, not on home's path at all)", candidate: path.join(path.sep, "etc") },
  { name: "an ancestor of home one level up (not itself shallow enough to be caught by the system-directory check alone)", candidate: path.join(path.sep, "Users", "alice") },
  { name: "an ancestor of home that is also a top-level OS directory", candidate: path.join(path.sep, "Users") },
  {
    name: "a path that would swallow an already-approved, unrelated root",
    candidate: path.join(home, "Desktop"),
    existingRoots: [path.join(home, "Desktop", "unrelated-project")],
  },
];

for (const { name, candidate, existingRoots } of dangerousCases) {
  test(`canRegisterRoot refuses: ${name}`, () => {
    assert.equal(canRegisterRoot(candidate, home, existingRoots ?? []), false);
  });
}

test("canRegisterRoot allows a directory git evidence actually justifies, alongside unrelated existing roots", () => {
  const derivedPool = path.join(home, ".ao", "data", "worktrees");
  assert.equal(canRegisterRoot(derivedPool, home, [path.join(home, "dev")]), true);
});

test("canRegisterRoot allows re-registering a path that exactly matches an existing root (no false positive on the swallow check)", () => {
  const existing = path.join(home, "dev");
  assert.equal(canRegisterRoot(existing, home, [existing]), true);
});
