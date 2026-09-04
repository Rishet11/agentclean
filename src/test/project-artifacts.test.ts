import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
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

test("node_modules without a lockfile is not a candidate", async () => {
  // The gate used to be `!(await packageLocks.some((l) => hasFile(root, l)))`,
  // which tests a Promise for truthiness and so always passed. A node_modules
  // with no lockfile cannot be rebuilt deterministically, so offering it is a
  // safety bug, not a cosmetic one.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-nolock-")));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  const old = new Date(Date.now() - 30 * 86_400_000);
  await utimes(path.join(root, "node_modules"), old, old);

  const candidates = await new ProjectArtifactProvider().discover(context(root));
  assert.deepEqual(candidates.filter((c) => c.category === "project-dependencies"), []);
  await rm(root, { recursive: true, force: true });
});

test("node_modules with a lockfile records which lockfile, for the restore command", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-lock-")));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n");
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  const old = new Date(Date.now() - 30 * 86_400_000);
  await utimes(path.join(root, "node_modules"), old, old);

  const candidates = await new ProjectArtifactProvider().discover(context(root));
  const deps = candidates.find((c) => c.category === "project-dependencies");
  assert.ok(deps, "expected a project-dependencies candidate");
  assert.equal(deps.metadata?.hasLockfile, true);
  assert.equal(deps.metadata?.lockfile, "pnpm-lock.yaml");
  await rm(root, { recursive: true, force: true });
});
