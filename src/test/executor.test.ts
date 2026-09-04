import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executePlan } from "../core/executor.js";
import { createPlan, hashValue } from "../core/plan.js";
import type { Candidate, ExecuteContext, Policy, StorageProvider } from "../core/types.js";

const policy: Policy = {
  version: 1,
  safeCacheAgeDays: 30,
  historyAgeDays: 90,
  worktreeInactiveDays: 30,
  autoCategories: ["ai-caches", "package-caches"],
  autoProviders: [],
  worktreeRoots: [],
};

function context(runDir: string): ExecuteContext {
  return {
    now: Date.now(),
    roots: [runDir],
    configRoots: [runDir],
    cwd: runDir,
    home: runDir,
    env: {},
    policy,
    dryRun: false,
    runDir,
  };
}

function baseCandidate(target: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
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
    ...overrides,
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

test("executor refuses a policy hash mismatch", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const plan = createPlan([], [runDir], Date.now(), { policyHash: "not-the-real-hash", platform: process.platform, home: runDir, providerIds: [] });
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /different policy, platform, home, or provider set/);
});

test("executor refuses a platform mismatch", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const plan = createPlan([], [runDir], Date.now(), { policyHash: hashValue(policy), platform: "not-a-real-platform", home: runDir, providerIds: [] });
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /different policy, platform, home, or provider set/);
});

test("executor refuses a home mismatch", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const plan = createPlan([], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: path.join(runDir, "other-home"), providerIds: [] });
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /different policy, platform, home, or provider set/);
});

test("executor refuses a provider set mismatch", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const plan = createPlan([], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: ["some-other-provider"] });
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /different policy, platform, home, or provider set/);
});

test("executor refuses a plan outside the current roots", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "agentclean-outside-"));
  const plan = createPlan([], [outsideRoot], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: [] });
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /outside the current roots/);
});

test("executor refuses an eligible non-verified provider candidate", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const target = path.join(runDir, "candidate");
  await writeFile(target, "still here");
  const candidate = baseCandidate(target, { providerStatus: "diagnostic", eligible: true });
  const plan = createPlan([candidate], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: [] });
  await assert.rejects(executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false }), /non-verified/);
});

test("dry-run revalidates but never executes", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-run-"));
  const target = path.join(runDir, "candidate");
  await writeFile(target, "still here");
  const beforeEntries = (await readdir(runDir)).sort();
  const beforeContent = await readFile(target, "utf8");
  const calls: string[] = [];
  const plan = createPlan([baseCandidate(target)], [runDir], Date.now(), { policyHash: hashValue(context(runDir).policy), platform: process.platform, home: runDir, providerIds: ["fake"] });
  const result = await executePlan(plan, new Map([["fake", fakeProvider(target, calls)]]), context(runDir), { dryRun: true, strict: false });
  assert.deepEqual(calls, []);
  assert.equal(result.results[0]?.status, "would-delete");
  const afterEntries = (await readdir(runDir)).sort();
  const afterContent = await readFile(target, "utf8");
  assert.deepEqual(afterEntries, beforeEntries);
  assert.equal(afterContent, beforeContent);
});

function heldFixtureProvider(): StorageProvider {
  return {
    id: "held", name: "Held", status: "verified",
    async detect() { return { id: "held", name: "Held", status: "verified" as const, details: "t", capabilities: [] }; },
    async discover() { return []; },
    explain() { return "t"; },
    async revalidate() { return { ok: true }; },
    async execute() { throw new Error("execute must not be reached: this item has no way back"); },
  };
}

function heldCandidate(target: string, restoreCost?: Candidate["restoreCost"]): Candidate {
  return {
    id: "held-1", provider: "held", providerStatus: "verified", category: "ai-history",
    action: "delete", target: { kind: "path", path: target }, reason: "t", evidence: ["t"],
    bytes: 12, fileCount: 1, mtimeMs: 0, eligible: true, blockers: [], autoSafe: false, restoreCost,
  };
}

async function runHeld(restoreCost?: Candidate["restoreCost"]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-held-")));
  const victim = path.join(root, "irreplaceable.txt");
  await writeFile(victim, "one of a kind\n");
  const context: ExecuteContext = {
    now: Date.now(), roots: [root], configRoots: [root], cwd: root, home: root, env: {},
    policy: { version: 1, safeCacheAgeDays: 30, historyAgeDays: 90, worktreeInactiveDays: 30, autoCategories: [], autoProviders: [], worktreeRoots: [] } as Policy,
    dryRun: false, runDir: root,
  };
  const candidate = heldCandidate(victim, restoreCost);
  const plan = createPlan([candidate], [root], context.now, { policyHash: hashValue(context.policy), platform: process.platform, home: root, providerIds: ["held"] });
  const result = await executePlan(plan, new Map([["held", heldFixtureProvider()]]), context, { dryRun: false, strict: false });
  return { root, victim, result };
}

test("an irreplaceable item is held, not destroyed, and never reaches provider.execute", async () => {
  const { root, victim, result } = await runHeld({ tier: "irreplaceable", seconds: "unknown", method: "", needsNetwork: false, confidence: "unknown" });
  try {
    assert.equal(result.results[0].status, "quarantined");
    assert.equal(result.deletedBytes, 0, "held bytes must never be counted as reclaimed");
    assert.equal(result.quarantinedBytes, 12);
    assert.ok(result.purgeAfter, "the user must be told when the space actually frees");
    assert.equal(existsSync(victim), false, "the original is moved out of the way");
    const held = result.results[0].quarantinePath;
    assert.ok(held && existsSync(held), "and it is still on disk, recoverable");
    assert.equal(await readFile(held, "utf8"), "one of a kind\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a candidate with no stated restore path is held rather than deleted", async () => {
  // Fail-closed: if the tool cannot say how you would get something back, it
  // does not get to delete it. This is the default for anything a provider
  // forgot to classify.
  const { root, result } = await runHeld(undefined);
  try {
    assert.equal(result.results[0].status, "quarantined");
    assert.equal(result.deletedBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
