import assert from "node:assert/strict";
import test from "node:test";
import { restoreCostFor, tierLabel, tierRank, tierSentence } from "../core/tiers.js";
import type { Candidate, Category } from "../core/types.js";

function candidate(category: Category, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "candidate",
    provider: "test",
    providerStatus: "verified",
    category,
    action: "delete",
    target: { kind: "path", path: "/home/example/target" },
    reason: "test candidate",
    evidence: ["documented"],
    bytes: 100,
    fileCount: 10,
    mtimeMs: 0,
    eligible: true,
    blockers: [],
    autoSafe: false,
    ...overrides,
  };
}

test("build-artifacts are free, offline, and name the build command", () => {
  for (const name of ["dist", ".next", "out", "target", "coverage", ".turbo"]) {
    const cost = restoreCostFor(candidate("build-artifacts", { metadata: { artifactName: name } }));
    assert.equal(cost.tier, "free");
    assert.equal(cost.needsNetwork, false);
    assert.notEqual(cost.method, "");
  }
});

test("package caches are cheap and take their method from the provider's own cleanup command", () => {
  const uv = restoreCostFor(candidate("package-caches", { provider: "uv", target: { kind: "command", command: ["uv", "cache", "prune"] } }));
  assert.equal(uv.tier, "cheap");
  assert.equal(uv.method, "uv cache prune");
  assert.equal(uv.needsNetwork, true);

  const go = restoreCostFor(candidate("package-caches", { provider: "go", target: { kind: "command", command: ["go", "clean", "-modcache"] } }));
  assert.equal(go.method, "go clean -modcache");
});

test("project-dependencies with lockfile evidence is cheap", () => {
  const cost = restoreCostFor(candidate("project-dependencies", { metadata: { hasLockfile: true } }));
  assert.equal(cost.tier, "cheap");
  assert.equal(cost.needsNetwork, true);
  assert.notEqual(cost.method, "");
});

test("SAFETY: project-dependencies without lockfile evidence is irreplaceable, never cheap", () => {
  const missingMetadata = restoreCostFor(candidate("project-dependencies"));
  assert.equal(missingMetadata.tier, "irreplaceable");
  assert.equal(missingMetadata.method, "");
  assert.equal(missingMetadata.seconds, "unknown");

  const explicitlyFalse = restoreCostFor(candidate("project-dependencies", { metadata: { hasLockfile: false } }));
  assert.equal(explicitlyFalse.tier, "irreplaceable");
});

test("project-environments with requirements evidence is cheap", () => {
  const cost = restoreCostFor(candidate("project-environments", { metadata: { hasRequirements: true } }));
  assert.equal(cost.tier, "cheap");
  assert.equal(cost.needsNetwork, true);
  assert.notEqual(cost.method, "");
});

test("SAFETY: a .venv without requirements evidence is irreplaceable, never cheap", () => {
  const missingMetadata = restoreCostFor(candidate("project-environments", { reason: "Python virtual environment: proj/.venv" }));
  assert.equal(missingMetadata.tier, "irreplaceable");
  assert.equal(missingMetadata.method, "");

  const explicitlyFalse = restoreCostFor(candidate("project-environments", { metadata: { hasRequirements: false } }));
  assert.equal(explicitlyFalse.tier, "irreplaceable");
});

test("clean worktrees are cheap and offline", () => {
  const cost = restoreCostFor(candidate("worktrees", { metadata: { worktreePath: "/repo/wt", branch: "feature" } }));
  assert.equal(cost.tier, "cheap");
  assert.equal(cost.needsNetwork, false);
  assert.equal(cost.method, "git worktree add /repo/wt feature");
});

test("worktrees with unpushed commits stay cheap but flag it loudly in the method", () => {
  const cost = restoreCostFor(candidate("worktrees", { metadata: { worktreePath: "/repo/wt", branch: "feature", unpushedCommits: 3 } }));
  assert.equal(cost.tier, "cheap");
  assert.match(cost.method, /3 unpushed commit/i);
});

test("ai-history is irreplaceable", () => {
  const cost = restoreCostFor(candidate("ai-history"));
  assert.equal(cost.tier, "irreplaceable");
  assert.equal(cost.method, "");
});

test("ai-caches are cheap, re-created on demand", () => {
  const cost = restoreCostFor(candidate("ai-caches"));
  assert.equal(cost.tier, "cheap");
  assert.notEqual(cost.method, "");
});

test("tierRank orders free < cheap < irreplaceable", () => {
  assert.ok(tierRank("free") < tierRank("cheap"));
  assert.ok(tierRank("cheap") < tierRank("irreplaceable"));
});

test("tierLabel and tierSentence cover every tier", () => {
  for (const tier of ["free", "cheap", "irreplaceable"] as const) {
    assert.equal(typeof tierLabel[tier], "string");
    assert.notEqual(tierLabel[tier], "");
    assert.equal(typeof tierSentence[tier], "string");
    assert.notEqual(tierSentence[tier], "");
  }
});
