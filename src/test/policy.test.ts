import assert from "node:assert/strict";
import test from "node:test";
import { autoPlan } from "../core/auto.js";
import { defaultPolicy, policyAllowsAuto } from "../core/policy.js";
import type { Candidate } from "../core/types.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "candidate",
    provider: "claude",
    providerStatus: "verified",
    category: "ai-caches",
    action: "delete",
    target: { kind: "path", path: "/home/example/.claude/cache/item" },
    reason: "cache",
    evidence: ["documented"],
    bytes: 10,
    fileCount: 1,
    mtimeMs: 0,
    eligible: true,
    blockers: [],
    autoSafe: true,
    ...overrides,
  };
}

test("safe policy allows old disposable Claude cache", () => {
  assert.equal(policyAllowsAuto(candidate(), defaultPolicy, 31 * 86_400_000), true);
});

test("safe policy blocks history and young caches", () => {
  assert.equal(policyAllowsAuto(candidate({ category: "ai-history" }), defaultPolicy, 365 * 86_400_000), false);
  assert.equal(policyAllowsAuto(candidate(), defaultPolicy, 1 * 86_400_000), false);
});

test("auto plan excludes blocked candidates", () => {
  const plan = autoPlan({ schemaVersion: 1, generatedAt: new Date(0).toISOString(), roots: [], policyHash: "policy", platform: process.platform, home: "/home", providerIds: ["claude", "codex"], candidates: [candidate(), candidate({ provider: "codex" })], hash: "" }, defaultPolicy, 31 * 86_400_000);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].provider, "claude");
});
