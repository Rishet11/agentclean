import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectArtifactProvider } from "../providers/project.js";
import type { ExecuteContext } from "../core/types.js";

function context(root: string): ExecuteContext {
  return {
    now: Date.now(),
    roots: [root],
    configRoots: [root],
    cwd: path.join(root, "outside-current-project"),
    home: root,
    env: {},
    policy: { version: 1, safeCacheAgeDays: 30, historyAgeDays: 90, worktreeInactiveDays: 30, autoCategories: [], autoProviders: [], worktreeRoots: [] },
    allowProjectArtifacts: true,
    dryRun: false,
    runDir: root,
  };
}

test("project provider finds rebuildable dependency, environment, and build folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentclean-project-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "build", "bundle.js"), "bundle\n");
  const pythonRoot = await mkdtemp(path.join(os.tmpdir(), "agentclean-python-"));
  await writeFile(path.join(root, "requirements.txt"), "pytest\n");
  await mkdir(path.join(root, ".venv"));
  await writeFile(path.join(root, ".venv", "pyvenv.cfg"), `home = ${pythonRoot}\n`);
  const old = new Date(Date.now() - 30 * 86_400_000);
  for (const name of ["node_modules", "build", ".venv"]) await utimes(path.join(root, name), old, old);
  const candidates = await new ProjectArtifactProvider().discover(context(root));
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.category)), new Set(["project-dependencies", "project-environments", "build-artifacts"]));
  assert.equal(candidates.every((candidate) => candidate.eligible), true);
});
