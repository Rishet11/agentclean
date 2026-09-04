import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executePlan } from "../core/executor.js";
import { createPlan, hashValue } from "../core/plan.js";
import type { ExecuteContext, StorageProvider } from "../core/types.js";

function context(runDir: string): ExecuteContext {
  return {
    now: Date.now(),
    roots: [runDir],
    configRoots: [runDir],
    cwd: runDir,
    home: runDir,
    env: {},
    policy: {
      version: 1,
      safeCacheAgeDays: 30,
      historyAgeDays: 90,
      worktreeInactiveDays: 30,
      autoCategories: ["ai-caches", "package-caches"],
      autoProviders: [],
      worktreeRoots: [],
    },
    dryRun: false,
    runDir,
  };
}

function fakeProvider(target: string, calls: string[]): StorageProvider {
  return {
    id: "fake",
    name: "Fake",
    status: "verified",
    async detect() { return { id: "fake", name: "Fake", status: "verified", details: "test", capabilities: [] }; },
    async discover() { return []; },
    explain() { return "test"; },
    async revalidate(candidate) { return { ok: candidate.target.kind === "path" && candidate.target.path === target }; },
    async execute(candidate) { calls.push(candidate.id); return { ok: true, bytes: candidate.bytes }; },
  };
}

test("executor refuses a tampered plan", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const plan = createPlan([], [runDir], Date.now(), { policyHash: hashValue(context(runDir).policy), platform: process.platform, home: runDir, providerIds: [] });
  plan.roots.push(path.join(runDir, "unexpected"));
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /invalid hash/);
});

test("dry-run revalidates but never executes", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const target = path.join(runDir, "candidate");
  await writeFile(target, "still here");
  const calls: string[] = [];
  const plan = createPlan([{
    id: "candidate",
    provider: "fake",
    providerStatus: "verified",
    category: "ai-caches",
    action: "delete",
    target: { kind: "path", path: target },
    reason: "test",
    evidence: ["test"],
    bytes: 10,
    fileCount: 1,
    mtimeMs: 0,
    eligible: true,
    blockers: [],
    autoSafe: true,
  }], [runDir], Date.now(), { policyHash: hashValue(context(runDir).policy), platform: process.platform, home: runDir, providerIds: ["fake"] });
  const result = await executePlan(plan, new Map([["fake", fakeProvider(target, calls)]]), context(runDir), { dryRun: true, strict: false });
  assert.deepEqual(calls, []);
  assert.equal(result.results[0]?.status, "would-delete");
  const entries = await (await import("node:fs/promises")).readdir(runDir);
  assert.deepEqual(entries, ["candidate"]);
  await writeFile(target, "still here");
  assert.equal(await readFile(target, "utf8"), "still here");
});
