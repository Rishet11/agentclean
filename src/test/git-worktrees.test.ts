import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runCommand } from "../core/command.js";
import { GitWorktreeProvider } from "../providers/git.js";
import type { Candidate, ExecuteContext, Policy } from "../core/types.js";

// The provider's own git calls (status, worktree list, submodule status,
// rev-list) go through core/command.ts's runCommand, which inherits
// process.env as-is -- it accepts no env override. Pointing GIT_CONFIG_GLOBAL
// at an empty, throwaway file (and disabling the system config) means those
// calls -- and every git command this file runs -- can't be perturbed by
// whatever is in the real developer's ~/.gitconfig or /etc/gitconfig. Node's
// test runner puts each *.test.ts file in its own process, so mutating
// process.env here does not leak into other test files.
const globalConfigDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-git-cfg-"));
const globalConfigPath = path.join(globalConfigDir, ".gitconfig");
await writeFile(globalConfigPath, "");
process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
process.env.GIT_CONFIG_NOSYSTEM = "1";

// This suite is itself run by a `git commit` pre-commit hook. Git exports
// GIT_DIR/GIT_INDEX_FILE (and friends) into a hook's environment so the hook
// can inspect the commit in progress -- and those variables override cwd-based
// repo discovery entirely. Left in place, every "isolated" git command below
// would silently operate on *this* real repository's in-progress commit
// instead of the temporary fixture, no matter what cwd is passed to spawn().
// Confirmed by reproducing it: without this, `git commit` inside a fixture
// worktree reported "On branch worktree-agent-..." and staged this project's
// own tracked files. Stripping them makes every git call below resolve its
// repo purely from the cwd it was given.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
]) {
  delete process.env[key];
}

after(async () => {
  await rm(globalConfigDir, { recursive: true, force: true });
});

const identity = ["-c", "user.email=agentclean-test@example.com", "-c", "user.name=agentclean-test"];

async function gitOk(args: string[], cwd: string): Promise<string> {
  const result = await runCommand(["git", ...args], cwd, 20_000);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function newRoot(prefix: string): Promise<string> {
  // realpath is required here: on macOS os.tmpdir() lives under /var, which is
  // itself a symlink to /private/var. findRepositories() in git.ts rejects any
  // root whose realpath differs from itself, specifically to guard against a
  // symlinked root smuggling a candidate outside the allowed tree. Passing the
  // raw mkdtemp() path would make every fixture in this file silently invisible
  // to discover(), not a git failure -- a much more confusing thing to debug.
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await gitOk(["init", "-q", "-b", "main"], dir);
  await writeFile(path.join(dir, "file.txt"), "hello\n");
  await gitOk([...identity, "add", "file.txt"], dir);
  await gitOk([...identity, "commit", "-q", "-m", "init"], dir);
}

async function addWorktree(mainDir: string, root: string, branch: string): Promise<string> {
  const target = path.join(root, branch);
  await gitOk(["branch", branch, "main"], mainDir);
  await gitOk(["worktree", "add", "-q", target, branch], mainDir);
  return target;
}

const policy: Policy = {
  version: 1,
  safeCacheAgeDays: 30,
  historyAgeDays: 90,
  worktreeInactiveDays: 30,
  autoCategories: [],
  autoProviders: [],
  worktreeRoots: [],
};

function makeContext(roots: string[], cwd: string): ExecuteContext {
  return {
    now: Date.now(),
    roots,
    configRoots: roots,
    cwd,
    home: cwd,
    env: process.env,
    policy,
    dryRun: true,
    runDir: cwd,
  };
}

function candidateFor(candidates: Candidate[], worktreePath: string): Candidate {
  const found = candidates.find((candidate) => candidate.metadata?.worktreePath === worktreePath);
  assert.ok(found, `expected a candidate for ${worktreePath}`);
  return found;
}

test("discover() returns exactly the linked worktrees -- the main worktree is never among them -- with correct blockers for clean, dirty, untracked, and locked worktrees", async () => {
  const root = await newRoot("agentclean-git-basic-");
  try {
    const mainDir = path.join(root, "main");
    await initRepo(mainDir);
    const clean = await addWorktree(mainDir, root, "wt-clean");
    const dirty = await addWorktree(mainDir, root, "wt-dirty");
    const untracked = await addWorktree(mainDir, root, "wt-untracked");
    const locked = await addWorktree(mainDir, root, "wt-locked");

    await writeFile(path.join(dirty, "file.txt"), "changed\n");
    await writeFile(path.join(untracked, "new.txt"), "new\n");
    await gitOk(["worktree", "lock", locked, "--reason", "test-lock"], mainDir);

    const context = makeContext([root], mainDir);
    const provider = new GitWorktreeProvider();
    const candidates = await provider.discover(context);

    assert.equal(candidates.length, 4, "exactly the four linked worktrees, no more, no less");
    assert.equal(
      candidates.some((candidate) => candidate.metadata?.worktreePath === mainDir),
      false,
      "the main worktree must never be offered as a candidate",
    );

    const cleanCandidate = candidateFor(candidates, clean);
    assert.equal(cleanCandidate.eligible, true);
    assert.deepEqual(cleanCandidate.blockers, []);

    const dirtyCandidate = candidateFor(candidates, dirty);
    assert.ok(dirtyCandidate.blockers.includes("dirty-or-untracked"));
    assert.equal(dirtyCandidate.eligible, false);

    const untrackedCandidate = candidateFor(candidates, untracked);
    assert.ok(untrackedCandidate.blockers.includes("dirty-or-untracked"));
    assert.equal(untrackedCandidate.eligible, false);

    const lockedCandidate = candidateFor(candidates, locked);
    assert.ok(lockedCandidate.blockers.includes("locked"));
    assert.equal(lockedCandidate.eligible, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discover() run with context.cwd inside a linked worktree still never returns the main worktree, and flags that worktree current-directory", async () => {
  const root = await newRoot("agentclean-git-cwd-");
  try {
    const mainDir = path.join(root, "main");
    await initRepo(mainDir);
    const clean = await addWorktree(mainDir, root, "wt-clean");
    const other = await addWorktree(mainDir, root, "wt-other");

    // context.cwd set to a linked worktree, as if the tool were invoked from inside it.
    const context = makeContext([root], clean);
    const provider = new GitWorktreeProvider();
    const candidates = await provider.discover(context);

    assert.equal(candidates.length, 2);
    assert.equal(
      candidates.some((candidate) => candidate.metadata?.worktreePath === mainDir),
      false,
      "main worktree still never offered, even when running from inside a linked worktree",
    );

    const cwdCandidate = candidateFor(candidates, clean);
    assert.ok(cwdCandidate.blockers.includes("current-directory"));

    const otherCandidate = candidateFor(candidates, other);
    assert.equal(otherCandidate.blockers.includes("current-directory"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revalidate() reflects live state: ok for a clean worktree, dirty-or-untracked once dirtied, locked once locked", async () => {
  const root = await newRoot("agentclean-git-revalidate-");
  try {
    const mainDir = path.join(root, "main");
    await initRepo(mainDir);
    const target = await addWorktree(mainDir, root, "wt-revalidate");

    const context = makeContext([root], mainDir);
    const provider = new GitWorktreeProvider();
    const [candidate] = await provider.discover(context);
    assert.equal(candidate.metadata?.worktreePath, target);
    assert.deepEqual(candidate.blockers, []);

    const okResult = await provider.revalidate(candidate, context);
    assert.equal(okResult.ok, true);

    await writeFile(path.join(target, "file.txt"), "dirtied\n");
    const dirtyResult = await provider.revalidate(candidate, context);
    assert.equal(dirtyResult.ok, false);
    assert.equal(dirtyResult.reason, "dirty-or-untracked");

    await gitOk(["worktree", "lock", target, "--reason", "test-lock"], mainDir);
    const lockedResult = await provider.revalidate(candidate, context);
    assert.equal(lockedResult.ok, false);
    assert.equal(lockedResult.reason, "locked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execute() (git worktree remove) deletes the working copy but preserves the branch and its commits in the shared .git; git worktree add restores it", async () => {
  const root = await newRoot("agentclean-git-execute-");
  try {
    const mainDir = path.join(root, "main");
    await initRepo(mainDir);
    const target = await addWorktree(mainDir, root, "wt-remove");

    await writeFile(path.join(target, "extra.txt"), "extra\n");
    await gitOk([...identity, "add", "extra.txt"], target);
    await gitOk([...identity, "commit", "-q", "-m", "extra-commit"], target);

    const context = makeContext([root], mainDir);
    const provider = new GitWorktreeProvider();
    const [candidate] = await provider.discover(context);
    assert.equal(candidate.metadata?.worktreePath, target);
    assert.deepEqual(candidate.blockers, []);

    const sha = (await gitOk(["rev-parse", "refs/heads/wt-remove"], mainDir)).trim();
    assert.match(sha, /^[0-9a-f]{40}$/);

    const result = await provider.execute(candidate);
    assert.equal(result.ok, true);

    const worktreeListing = await gitOk(["worktree", "list"], mainDir);
    assert.equal(worktreeListing.includes(target), false, "the working copy is gone from git worktree list");

    const shaAfter = (await gitOk(["rev-parse", "refs/heads/wt-remove"], mainDir)).trim();
    assert.equal(shaAfter, sha, "the branch ref still resolves to the same commit after removal");

    const catFile = await runCommand(["git", "cat-file", "-e", `${sha}^{commit}`], mainDir, 20_000);
    assert.equal(catFile.code, 0, "the commit object is still present in the shared .git");

    const restored = path.join(root, "wt-restored");
    await gitOk(["worktree", "add", restored, "wt-remove"], mainDir);
    const restoredContent = await runCommand(["cat", path.join(restored, "extra.txt")], mainDir, 20_000);
    assert.equal(restoredContent.stdout, "extra\n", "git worktree add restores a working tree with the commit present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submodule status: uninitialized (-) is harmless, but a checked-out commit that differs from the index (+) blocks removal", async () => {
  const root = await newRoot("agentclean-git-submodule-");
  try {
    const otherDir = path.join(root, "other");
    await initRepo(otherDir);

    const mainDir = path.join(root, "main");
    await initRepo(mainDir);
    await gitOk(["-c", "protocol.file.allow=always", "submodule", "add", "../other", "sub"], mainDir);
    await gitOk([...identity, "commit", "-q", "-m", "add-submodule"], mainDir);

    const target = await addWorktree(mainDir, root, "wt-sub");
    const context = makeContext([root], mainDir);
    const provider = new GitWorktreeProvider();

    // Freshly-added linked worktrees never have their submodules checked out;
    // `git submodule status` reports that with a leading "-", meaning there is
    // nothing on disk to lose. It must not block removal.
    const [beforeInit] = await provider.discover(context);
    assert.equal(beforeInit.metadata?.worktreePath, target);
    assert.equal(beforeInit.metadata?.uninitializedSubmodules, 1);
    assert.equal(beforeInit.metadata?.dirtySubmodules, 0);
    assert.equal(beforeInit.blockers.includes("dirty-submodules"), false);
    assert.deepEqual(beforeInit.blockers, []);

    // Initialize the submodule, then commit locally inside it so its checked-out
    // commit differs from what the superproject's index records ("+"). Now
    // there is real, uncommitted-to-the-index state in the worktree to lose.
    await gitOk(["-c", "protocol.file.allow=always", "submodule", "update", "--init"], target);
    const subPath = path.join(target, "sub");
    await writeFile(path.join(subPath, "extra.txt"), "extra\n");
    await gitOk([...identity, "add", "extra.txt"], subPath);
    await gitOk([...identity, "commit", "-q", "-m", "extra-in-submodule"], subPath);

    const [afterDirty] = await provider.discover(context);
    assert.equal(afterDirty.metadata?.worktreePath, target);
    assert.equal(afterDirty.metadata?.dirtySubmodules, 1);
    assert.ok(afterDirty.blockers.includes("dirty-submodules"));
    assert.equal(afterDirty.eligible, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
