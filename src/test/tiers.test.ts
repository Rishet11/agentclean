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

test("new package-cache providers (yarn, bun, pip) are cheap with a non-empty method taken from their own command", () => {
  const yarn = restoreCostFor(candidate("package-caches", { provider: "yarn", target: { kind: "command", command: ["yarn", "cache", "clean"] } }));
  assert.equal(yarn.tier, "cheap");
  assert.equal(yarn.needsNetwork, true);
  assert.equal(yarn.method, "yarn cache clean");
  assert.notEqual(yarn.method, "");

  const bun = restoreCostFor(candidate("package-caches", { provider: "bun", target: { kind: "command", command: ["bun", "pm", "cache", "rm"] } }));
  assert.equal(bun.tier, "cheap");
  assert.equal(bun.needsNetwork, true);
  assert.equal(bun.method, "bun pm cache rm");
  assert.notEqual(bun.method, "");

  const pip = restoreCostFor(candidate("package-caches", { provider: "pip", target: { kind: "command", command: ["pip3", "cache", "purge"] } }));
  assert.equal(pip.tier, "cheap");
  assert.equal(pip.needsNetwork, true);
  assert.equal(pip.method, "pip3 cache purge");
  assert.notEqual(pip.method, "");
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
