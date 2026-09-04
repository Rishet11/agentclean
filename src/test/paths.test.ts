import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isWithin, isWithinAny, samePath } from "../core/paths.js";
import { measureTree, removeTree } from "../core/filesystem.js";

test("path checks reject sibling prefix escapes", () => {
  assert.equal(isWithin("/tmp/project", "/tmp/project-old/file"), false);
  assert.equal(isWithinAny(["/tmp/one", "/tmp/project"], "/tmp/project/file"), true);
});

test("samePath compares drive-like paths case-insensitively only on Windows", () => {
  const left = process.platform === "win32" ? "C:\\Project" : "/tmp/Project";
  const right = process.platform === "win32" ? "c:\\project" : "/tmp/project";
  assert.equal(samePath(left, right), process.platform === "win32");
});

test("measure and remove refuse symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentclean-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "agentclean-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  const link = path.join(root, "link");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(measureTree(link), /reparse-point/);
  await assert.rejects(removeTree(link), /reparse-point/);
});
