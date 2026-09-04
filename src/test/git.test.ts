import assert from "node:assert/strict";
import test from "node:test";
import { parseWorktrees } from "../providers/git.js";

test("porcelain worktree records preserve spaces and flags", () => {
  const parsed = parseWorktrees("worktree C:\\repo\0HEAD abc\0\0worktree C:\\work tree\0branch refs/heads/feature\0locked reason\0\0");
  assert.deepEqual(parsed, [
    { path: "C:\\repo", locked: false, prunable: false },
    { path: "C:\\work tree", branch: "refs/heads/feature", locked: true, prunable: false },
  ]);
});
