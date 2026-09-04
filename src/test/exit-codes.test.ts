import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanExitCode } from "../cli.js";
import { executePlan } from "../core/executor.js";
import { createPlan, hashValue } from "../core/plan.js";
import { EXIT_OK, EXIT_PARTIAL } from "../core/errors.js";
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
  return { now: Date.now(), roots: [runDir], configRoots: [runDir], cwd: runDir, home: runDir, env: {}, policy, dryRun: false, runDir };
}

function declinedCandidate(target: string): Candidate {
  return {
    id: "declined",
    provider: "fake",
    providerStatus: "verified",
    category: "ai-caches",
    action: "delete",
    target: { kind: "path", path: target },
    reason: "younger than 30 days",
    evidence: ["test"],
    bytes: 100,
    fileCount: 1,
    mtimeMs: 0,
    eligible: false,
    blockers: ["younger-than-30-days"],
    autoSafe: false,
    restoreCost: { tier: "cheap" as const, seconds: 5, method: "the provider re-creates this", needsNetwork: false, confidence: "estimated" as const },
  };
}

function passingCandidate(target: string): Candidate {
  return {
    id: "passing",
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
    restoreCost: { tier: "cheap" as const, seconds: 5, method: "the provider re-creates this", needsNetwork: false, confidence: "estimated" as const },
  };
}

function fakeProvider(behavior: "succeed" | "fail"): StorageProvider {
  return {
    id: "fake",
    name: "Fake",
    status: "verified",
    async detect() { return { id: "fake", name: "Fake", status: "verified", details: "test", capabilities: [] }; },
    async discover() { return []; },
    explain() { return "test"; },
    async revalidate() { return { ok: true }; },
    async execute(candidate) { return behavior === "succeed" ? { ok: true, bytes: candidate.bytes } : { ok: false, bytes: 0, reason: "boom" }; },
  };
}

test("a plan whose only candidate is ineligible-by-design exits 0, not 3", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-exit-"));
  const target = path.join(runDir, "young-cache");
  await writeFile(target, "data");
  const plan = createPlan([declinedCandidate(target)], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: [] });
  const result = await executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: false });
  assert.equal(result.results[0]?.status, "declined");
  assert.equal(result.failedBytes, 0);
  assert.equal(result.skippedBytes, 0);
  assert.equal(cleanExitCode(result), EXIT_OK);
});

test("the same declined-only plan with --strict exits 3", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-exit-"));
  const target = path.join(runDir, "young-cache");
  await writeFile(target, "data");
  const plan = createPlan([declinedCandidate(target)], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: [] });
  const result = await executePlan(plan, new Map(), context(runDir), { dryRun: false, strict: true });
  assert.equal(result.strictViolation, true);
  assert.equal(cleanExitCode(result), EXIT_PARTIAL);
});

test("a candidate that genuinely fails exits 3", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-exit-"));
  const target = path.join(runDir, "candidate");
  await writeFile(target, "data");
  const plan = createPlan([passingCandidate(target)], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: ["fake"] });
  const result = await executePlan(plan, new Map([["fake", fakeProvider("fail")]]), context(runDir), { dryRun: false, strict: false });
  assert.equal(result.results[0]?.status, "failed");
  assert.equal(cleanExitCode(result), EXIT_PARTIAL);
});

test("a candidate that succeeds exits 0", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "agentclean-exit-"));
  const target = path.join(runDir, "candidate");
  await writeFile(target, "data");
  const plan = createPlan([passingCandidate(target)], [runDir], Date.now(), { policyHash: hashValue(policy), platform: process.platform, home: runDir, providerIds: ["fake"] });
  const result = await executePlan(plan, new Map([["fake", fakeProvider("succeed")]]), context(runDir), { dryRun: false, strict: false });
  assert.equal(result.results[0]?.status, "deleted");
  assert.equal(cleanExitCode(result), EXIT_OK);
});
