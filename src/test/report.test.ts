import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, verifyPlan } from "../core/plan.js";
import { buildReport, MIN_GROUP_SIZE, ROW_BYTES_THRESHOLD } from "../core/report.js";
import type { Candidate, Category, Plan, RestoreTier } from "../core/types.js";

let nextId = 0;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  nextId += 1;
  return {
    id: `candidate-${nextId}`,
    provider: "test",
    providerStatus: "verified",
    category: "ai-caches",
    action: "delete",
    target: { kind: "path", path: `/home/example/target-${nextId}` },
    reason: "test candidate",
    evidence: ["documented"],
    bytes: 100,
    fileCount: 1,
    mtimeMs: 0,
    eligible: true,
    blockers: [],
    autoSafe: false,
    restoreCost: { tier: "cheap", seconds: 10, method: "some restore command", needsNetwork: false, confidence: "estimated" },
    ...overrides,
  };
}

function plan(candidates: Candidate[]): Plan {
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), roots: [], policyHash: "policy", platform: process.platform, home: "/home", providerIds: [], candidates, hash: "unused" };
}

// ---------------------------------------------------------------------------
// Collapse rule, as a table: (provider, category, tier, dirname) is the group
// key; >= 1 MiB always stands alone; a lone small candidate stands alone too;
// only >= 2 small candidates sharing the key collapse; provider-command never
// collapses no matter what it shares.
// ---------------------------------------------------------------------------

test("collapse rule: candidates at or above the size threshold always get their own row, even sharing everything", () => {
  const shared = { provider: "uv", category: "package-caches" as Category, target: { kind: "path" as const, path: "/home/example/.cache/uv/a" } };
  const candidates = [
    candidate({ ...shared, bytes: ROW_BYTES_THRESHOLD }),
    candidate({ ...shared, bytes: ROW_BYTES_THRESHOLD * 2 }),
    candidate({ ...shared, bytes: ROW_BYTES_THRESHOLD * 3 }),
  ];
  const model = buildReport(plan(candidates));
  assert.equal(model.rows.length, 3);
  assert.ok(model.rows.every((row) => row.kind === "single"));
});

test("collapse rule: a lone small candidate with no sibling stays its own row", () => {
  const model = buildReport(plan([candidate({ bytes: 10 * 1024 })]));
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].kind, "single");
  assert.equal(model.rows[0].count, 1);
});

test(`collapse rule: >= ${MIN_GROUP_SIZE} small candidates sharing (provider, category, tier, dirname) collapse into one row`, () => {
  const dirname = "/home/example/.codex/cache";
  const candidates = Array.from({ length: 5 }, (_, index) => candidate({ provider: "codex", category: "ai-caches", bytes: 10 * 1024, target: { kind: "path", path: `${dirname}/entry-${index}` } }));
  const model = buildReport(plan(candidates));
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].kind, "group");
  assert.equal(model.rows[0].count, 5);
  assert.equal(model.rows[0].bytes, 5 * 10 * 1024);
  assert.deepEqual(new Set(model.rows[0].candidateIds), new Set(candidates.map((c) => c.id)));
});

test("collapse rule: small candidates that differ only in dirname do not collapse together", () => {
  const candidates = [
    candidate({ provider: "cursor", category: "ai-caches", bytes: 1024, target: { kind: "path", path: "/home/example/Cursor/Cache/a" } }),
    candidate({ provider: "cursor", category: "ai-caches", bytes: 1024, target: { kind: "path", path: "/home/example/Cursor/CachedData/b" } }),
  ];
  const model = buildReport(plan(candidates));
  assert.equal(model.rows.length, 2);
  assert.ok(model.rows.every((row) => row.kind === "single"));
});

test("collapse rule: provider-command candidates never group, even sharing provider/category/tier and a small size", () => {
  const shared = { provider: "npm", category: "package-caches" as Category, action: "provider-command" as const, bytes: 10 * 1024, target: { kind: "command" as const, command: ["npm", "cache", "clean", "--force"] } };
  const candidates = [candidate(shared), candidate(shared)];
  const model = buildReport(plan(candidates));
  assert.equal(model.rows.length, 2);
  assert.ok(model.rows.every((row) => row.kind === "single"));
});

test("collapse rule: exactly at the byte threshold is 'big' (own row); one byte under, shared with a sibling, collapses", () => {
  const dirname = "/home/example/.opencode/cache";
  const candidates = [
    candidate({ bytes: ROW_BYTES_THRESHOLD, target: { kind: "path", path: `${dirname}/solo` } }),
    candidate({ bytes: ROW_BYTES_THRESHOLD - 1, target: { kind: "path", path: `${dirname}/a` } }),
    candidate({ bytes: ROW_BYTES_THRESHOLD - 1, target: { kind: "path", path: `${dirname}/b` } }),
  ];
  const model = buildReport(plan(candidates));
  assert.equal(model.rows.length, 2);
  const single = model.rows.find((row) => row.bytes === ROW_BYTES_THRESHOLD);
  const group = model.rows.find((row) => row.count === 2);
  assert.equal(single?.kind, "single");
  assert.equal(group?.kind, "group");
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test("buildReport does not mutate the plan or its candidates", () => {
  const candidates = [
    candidate({ category: "ai-history", eligible: false, blockers: ["history-requires-explicit-opt-in"], restoreCost: { tier: "irreplaceable", seconds: "unknown", method: "", needsNetwork: false, confidence: "unknown" } }),
    candidate({ bytes: 5 * 1024 * 1024 }),
    candidate({ bytes: 5 * 1024 * 1024 }),
  ];
  const original = createPlan(candidates, ["/root"], 0, { policyHash: "policy", platform: process.platform, home: "/home", providerIds: ["test"] });
  const before = JSON.parse(JSON.stringify(original));

  buildReport(original, { maxRows: 1 });

  assert.deepEqual(original, before);
  assert.equal(verifyPlan(original), true);
});

// ---------------------------------------------------------------------------
// A synthetic 677-candidate plan, shaped like the real measured machine: a
// handful of large single rows (uv, npm, pnpm, go, git worktrees, project
// dependencies, antigravity history) plus a long tail of hundreds of
// sub-megabyte cache/history files (245 codex, 35 cursor, and more) that
// should collapse hard.
// ---------------------------------------------------------------------------

function bigRow(overrides: Partial<Candidate>): Candidate {
  return candidate({ bytes: 1024 * 1024 * 1024, ...overrides });
}

function tailGroup(count: number, options: { provider: string; category: Category; tier: RestoreTier; dirname: string; blocked?: boolean }): Candidate[] {
  const { provider, category, tier, dirname, blocked } = options;
  return Array.from({ length: count }, (_, index) =>
    candidate({
      provider,
      category,
      bytes: 50 * 1024,
      target: { kind: "path", path: `${dirname}/item-${index}` },
      eligible: !blocked,
      blockers: blocked ? ["history-requires-explicit-opt-in"] : [],
      restoreCost: { tier, seconds: blocked ? "unknown" : 5, method: blocked ? "" : "provider re-creates this on demand", needsNetwork: false, confidence: blocked ? "unknown" : "estimated" },
    }),
  );
}

test("a synthetic 677-candidate plan shaped like the real machine collapses to well under 20 rows", () => {
  const big: Candidate[] = [
    bigRow({ provider: "uv", category: "package-caches", action: "provider-command", target: { kind: "command", command: ["uv", "cache", "prune"] }, bytes: 10.06 * 1024 ** 3 }),
    bigRow({ provider: "npm", category: "package-caches", action: "provider-command", target: { kind: "command", command: ["npm", "cache", "clean", "--force"] }, bytes: 3.01 * 1024 ** 3 }),
    bigRow({ provider: "pnpm", category: "package-caches", action: "provider-command", target: { kind: "command", command: ["pnpm", "store", "prune"] }, bytes: 1.12 * 1024 ** 3 }),
    bigRow({ provider: "go", category: "package-caches", action: "provider-command", target: { kind: "command", command: ["go", "clean", "-modcache"] }, bytes: 1.04 * 1024 ** 3 }),
    bigRow({ provider: "git", category: "worktrees", target: { kind: "path", path: "/home/example/repo/.worktrees/old-branch" }, bytes: 9.74 * 1024 ** 3 }),
    bigRow({ provider: "project", category: "project-dependencies", target: { kind: "path", path: "/home/example/repo/node_modules" }, bytes: 3.05 * 1024 ** 3, restoreCost: { tier: "cheap", seconds: 120, method: "npm ci", needsNetwork: true, confidence: "estimated" } }),
    bigRow({ provider: "antigravity", category: "ai-history", target: { kind: "path", path: "/home/example/.gemini/antigravity/conversations" }, bytes: 2.9 * 1024 ** 3, eligible: false, blockers: ["history-requires-explicit-opt-in"], restoreCost: { tier: "irreplaceable", seconds: "unknown", method: "", needsNetwork: false, confidence: "unknown" } }),
  ];

  const tail: Candidate[] = [
    ...tailGroup(150, { provider: "codex", category: "ai-caches", tier: "cheap", dirname: "/home/example/.codex/.tmp" }),
    ...tailGroup(95, { provider: "codex", category: "ai-caches", tier: "cheap", dirname: "/home/example/.codex/cache" }),
    ...tailGroup(30, { provider: "codex", category: "ai-history", tier: "irreplaceable", dirname: "/home/example/.codex/sessions/2026/01", blocked: true }),
    ...tailGroup(20, { provider: "cursor", category: "ai-caches", tier: "cheap", dirname: "/home/example/Library/Application Support/Cursor/Cache" }),
    ...tailGroup(15, { provider: "cursor", category: "ai-caches", tier: "cheap", dirname: "/home/example/Library/Application Support/Cursor/CachedData" }),
    ...tailGroup(200, { provider: "opencode", category: "ai-caches", tier: "cheap", dirname: "/home/example/.local/share/opencode/cache" }),
    ...tailGroup(100, { provider: "claude", category: "ai-caches", tier: "cheap", dirname: "/home/example/.claude/paste-cache" }),
    ...tailGroup(40, { provider: "gemini", category: "ai-caches", tier: "cheap", dirname: "/home/example/.gemini/cache" }),
    ...tailGroup(20, { provider: "opencode", category: "ai-caches", tier: "cheap", dirname: "/home/example/.local/share/opencode/log" }),
  ];

  const candidates = [...big, ...tail];
  // Sanity on the fixture itself before asserting on buildReport's behavior.
  assert.equal(candidates.length, 677);
  assert.equal(tail.length, 150 + 95 + 30 + 20 + 15 + 200 + 100 + 40 + 20);

  const model = buildReport(plan(candidates));
  assert.equal(model.totalCandidates, 677);
  assert.equal(model.rows.length, big.length + 9); // 7 big rows + 9 collapsed tail groups
  assert.ok(model.rows.length < 20, `expected well under 20 rows, got ${model.rows.length}`);

  // The 245 codex ai-caches entries collapse to exactly 2 rows (two disposable roots).
  const codexCacheRows = model.rows.filter((row) => row.provider === "codex" && row.category === "ai-caches");
  assert.equal(codexCacheRows.length, 2);
  assert.equal(codexCacheRows.reduce((sum, row) => sum + row.count, 0), 245);

  // The 35 cursor entries collapse to exactly 2 rows.
  const cursorRows = model.rows.filter((row) => row.provider === "cursor");
  assert.equal(cursorRows.length, 2);
  assert.equal(cursorRows.reduce((sum, row) => sum + row.count, 0), 35);

  // History stays visible, with size, but ineligible - never pre-selectable.
  const historyRows = model.rows.filter((row) => row.category === "ai-history");
  assert.ok(historyRows.every((row) => row.eligible === false));
  assert.ok(historyRows.some((row) => row.bytes > 0));
});
