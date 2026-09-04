import assert from "node:assert/strict";
import test from "node:test";

function parseWorktrees(output: string): Array<{ path: string; branch?: string; locked: boolean; prunable: boolean }> {
  const entries: Array<{ path: string; branch?: string; locked: boolean; prunable: boolean }> = [];
  let current: { path: string; branch?: string; locked: boolean; prunable: boolean } | undefined;
  for (const token of output.split("\0")) {
    if (!token) { if (current?.path) entries.push(current); current = undefined; continue; }
    if (token.startsWith("worktree ")) { if (current?.path) entries.push(current); current = { path: token.slice(9), locked: false, prunable: false }; }
    else if (current && token.startsWith("branch ")) current.branch = token.slice(7);
    else if (current && (token === "locked" || token.startsWith("locked "))) current.locked = true;
    else if (current && (token === "prunable" || token.startsWith("prunable "))) current.prunable = true;
  }
  if (current?.path) entries.push(current);
  return entries;
}

test("porcelain worktree records preserve spaces and flags", () => {
  const parsed = parseWorktrees("worktree C:\\repo\0HEAD abc\0\0worktree C:\\work tree\0branch refs/heads/feature\0locked reason\0\0");
  assert.deepEqual(parsed, [
    { path: "C:\\repo", locked: false, prunable: false },
    { path: "C:\\work tree", branch: "refs/heads/feature", locked: true, prunable: false },
  ]);
});
