import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand, scrubbedEnvironment } from "../core/command.js";

test("commands use argument boundaries instead of a shell", async () => {
  const result = await runCommand([process.execPath, "-e", "process.stdout.write(process.argv[1])", "value with spaces; not shell code"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "value with spaces; not shell code");
});

test("git repository-scoping variables never reach a spawned command", () => {
  // Git exports these to the processes it spawns, so agentclean running inside
  // a hook or a `rebase -x` would inherit them. With GIT_DIR set, a `git status`
  // aimed at a worktree reports a different repository's state, which can make a
  // worktree holding uncommitted work look clean enough to remove.
  const polluted = {
    PATH: "/usr/bin",
    GIT_DIR: "/somewhere/else/.git",
    GIT_WORK_TREE: "/somewhere/else",
    GIT_INDEX_FILE: "/somewhere/else/.git/index",
    GIT_COMMON_DIR: "/somewhere/else/.git",
    GIT_CEILING_DIRECTORIES: "/",
  };
  const clean = scrubbedEnvironment(polluted);
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"]) {
    assert.equal(clean[name], undefined, `${name} must not survive`);
  }
  assert.equal(clean.PATH, "/usr/bin", "unrelated variables are preserved");
  assert.equal(clean.GIT_TERMINAL_PROMPT, "0", "never block on a credential prompt");
});

test("a git command resolves from cwd even when GIT_DIR points elsewhere", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-gitenv-")));
  try {
    await runCommand(["git", "init", "-q", root], root, 20_000);
    process.env.GIT_DIR = "/nonexistent/decoy/.git";
    const result = await runCommand(["git", "rev-parse", "--show-toplevel"], root, 20_000);
    assert.equal(result.code, 0, `git should resolve from cwd, got: ${result.stderr}`);
    assert.equal(await realpath(result.stdout.trim()), root);
  } finally {
    delete process.env.GIT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
