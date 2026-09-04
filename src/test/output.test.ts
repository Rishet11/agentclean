import assert from "node:assert/strict";
import test from "node:test";
import { createPlan } from "../core/plan.js";
import {
  formatBytes,
  humanFailure,
  humanReason,
  plainRestore,
  printResult,
  printSummary,
  shortLabel,
  shortLabelForCandidate,
} from "../core/output.js";
import type { Candidate, Plan, RunResult } from "../core/types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Sink = NodeJS.WritableStream & { isTTY?: boolean; text(): string };

function sink(isTTY = false): Sink {
  const chunks: string[] = [];
  return {
    isTTY,
    write: ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as Sink["write"],
    text() {
      return chunks.join("");
    },
  } as unknown as Sink;
}

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
  return createPlan(candidates, ["/root"], 0, { policyHash: "policy", platform: process.platform, home: "/home", providerIds: ["test"] });
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 2,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1_500).toISOString(),
    planHash: "unused",
    dryRun: false,
    results: [],
    deletedBytes: 0,
    wouldDeleteBytes: 0,
    declinedBytes: 0,
    skippedBytes: 0,
    failedBytes: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shortLabel / shortLabelForCandidate: plain-word translations a person who
// has never heard of pnpm or uv can act on.
// ---------------------------------------------------------------------------

test("shortLabel: package-cache providers all read as plain-language downloads, not tool jargon", () => {
  assert.equal(shortLabel({ provider: "uv", category: "package-caches", label: "" }), "Python downloads");
  assert.equal(shortLabel({ provider: "pip", category: "package-caches", label: "" }), "Python downloads");
  assert.equal(shortLabel({ provider: "pnpm", category: "package-caches", label: "" }), "JavaScript downloads");
  assert.equal(shortLabel({ provider: "go", category: "package-caches", label: "" }), "Go downloads");
});

test("shortLabel: build artifacts and dependencies name the project, not the raw path", () => {
  const label = shortLabel({ provider: "project", category: "build-artifacts", label: "/home/example/repo/frontend/dist" });
  assert.match(label, /^build files, /);
  assert.ok(!label.includes("/home"), "must not leak the raw absolute path");
});

test("shortLabel: ai-history is always 'past conversations', regardless of provider", () => {
  assert.equal(shortLabel({ provider: "codex", category: "ai-history", label: "/home/example/.codex/sessions" }), "past conversations");
  assert.equal(shortLabel({ provider: "claude", category: "ai-history", label: "/home/example/.claude/history" }), "past conversations");
});

test("shortLabelForCandidate builds the label from a real Candidate's target, matching shortLabel's row-shaped equivalent", () => {
  const pathCandidate = candidate({ provider: "project", category: "build-artifacts", target: { kind: "path", path: "/home/example/spaceatc/frontend/dist" } });
  assert.equal(shortLabelForCandidate(pathCandidate), shortLabel({ provider: "project", category: "build-artifacts", label: "/home/example/spaceatc/frontend/dist" }));

  const commandCandidate = candidate({ provider: "uv", category: "package-caches", action: "provider-command", target: { kind: "command", command: ["uv", "cache", "prune"] } });
  assert.equal(shortLabelForCandidate(commandCandidate), "Python downloads");
});

// ---------------------------------------------------------------------------
// humanReason: blocker ids -> plain words (checklist.ts and report.ts both
// depend on this signature staying stable).
// ---------------------------------------------------------------------------

test("humanReason translates every documented blocker id to plain words", () => {
  assert.equal(humanReason("younger-than-30-days"), "recently used");
  assert.equal(humanReason("history-requires-explicit-opt-in"), "chat history");
  assert.equal(humanReason("dirty-or-untracked"), "unsaved work");
  assert.equal(humanReason("outside-allowed-root"), "outside your folders");
  assert.equal(humanReason("locked"), "locked");
  assert.equal(humanReason("missing-or-prunable"), "already gone");
});

test("humanReason falls back to a dash-stripped reading for an unrecognized reason, never throwing", () => {
  assert.equal(humanReason("some-new-blocker"), "some new blocker");
});

// ---------------------------------------------------------------------------
// humanFailure: raw OS/provider errors -> a sentence saying what happened.
// Advice included is limited to what this codebase's own behavior supports
// (see the comment on humanFailure in output.ts).
// ---------------------------------------------------------------------------

test("humanFailure: ENOSPC reads as running out of disk space, with the honest 'run clean again' recovery", () => {
  const message = humanFailure("ENOSPC: no space left on device, write '/home/example/.cache/uv/tmp123'");
  assert.match(message, /ran out of disk space/i);
  assert.match(message, /run clean again/i);
});

test("humanFailure: a missing provider command (spawn ENOENT) names the tool and says nothing was deleted", () => {
  const message = humanFailure("spawn uv ENOENT");
  assert.match(message, /\buv\b/);
  assert.match(message, /isn't installed/i);
  assert.match(message, /nothing was deleted/i);
});

test("humanFailure: EACCES/EPERM reads as a permission problem, not a raw errno", () => {
  assert.match(humanFailure("EACCES: permission denied, unlink '/home/example/protected'"), /no permission/i);
  assert.match(humanFailure("EPERM: operation not permitted, unlink '/home/example/protected'"), /no permission/i);
});

test("humanFailure: a nonzero provider command exit reads as the tool reporting an error", () => {
  assert.match(humanFailure("provider command exited 1"), /reported an error/i);
});

test("humanFailure passes through anything it does not recognize, rather than inventing an explanation", () => {
  assert.equal(humanFailure("some completely novel failure string"), "some completely novel failure string");
});

// ---------------------------------------------------------------------------
// printSummary: the empty / first-run case must reassure, not show a bare
// "0 B found" header.
// ---------------------------------------------------------------------------

test("printSummary: an empty plan reassures instead of printing a bare zero-byte header", () => {
  const stream = sink();
  printSummary(plan([]), stream);
  const text = stream.text();
  assert.match(text, /nothing to clean here/i);
  assert.ok(!text.includes("0 B found"), "must not fall through to the numeric header on an empty plan");
  // Points to a real, working next step (both flags exist on the real CLI).
  assert.match(text, /--project-artifacts/);
  assert.match(text, /config root add/);
});

test("printSummary: a non-empty plan still shows the numeric header", () => {
  const stream = sink();
  printSummary(plan([candidate({ bytes: 5 * 1024 * 1024 })]), stream);
  assert.match(stream.text(), /found/i);
});

// ---------------------------------------------------------------------------
// printResult: the redesigned delete-flow result screen.
// ---------------------------------------------------------------------------

test("printResult: nothing in the plan at all reads as reassuring, not a wall of zeroed counters", () => {
  const stream = sink();
  printResult(runResult({ results: [] }), plan([]), stream);
  const text = stream.text();
  assert.match(text, /nothing to clean here/i);
  assert.ok(!text.includes("Would delete: 0 B"));
  assert.ok(!text.includes("Skipped: 0 B"));
});

test("printResult: a real run states what was freed, in plain words, using the candidate's shortLabel", () => {
  const uvCandidate = candidate({ provider: "uv", category: "package-caches", action: "provider-command", target: { kind: "command", command: ["uv", "cache", "prune"] }, bytes: 10 * 1024 ** 3 });
  const built = plan([uvCandidate]);
  const result = runResult({
    deletedBytes: uvCandidate.bytes,
    results: [{ candidateId: uvCandidate.id, status: "deleted", bytes: uvCandidate.bytes }],
  });

  const stream = sink();
  printResult(result, built, stream);
  const text = stream.text();

  assert.match(text, /Freed/);
  assert.match(text, /Python downloads/);
  assert.ok(!text.includes(uvCandidate.id), "a raw candidate hash must never appear in the human view");
  assert.ok(!text.includes("Would delete"), "a real (non-dry) run must never show the meaningless 'would delete' line");
});

test("printResult: a --dry-run preview says 'would free', never 'freed'", () => {
  const target = candidate({ bytes: 2 * 1024 * 1024 });
  const built = plan([target]);
  const result = runResult({
    dryRun: true,
    wouldDeleteBytes: target.bytes,
    results: [{ candidateId: target.id, status: "would-delete", bytes: target.bytes }],
  });

  const stream = sink();
  printResult(result, built, stream);
  const text = stream.text();
  assert.match(text, /Would free/);
  assert.ok(!text.includes("Freed "), "a dry run must not claim things were actually freed");
});

test("printResult: skipped/declined candidates are aggregated by plain-word reason, not printed one hash per line", () => {
  const outsideA = candidate({ blockers: ["outside-allowed-root"] });
  const outsideB = candidate({ blockers: ["outside-allowed-root"] });
  const locked = candidate({ blockers: ["locked"] });
  const built = plan([outsideA, outsideB, locked]);
  const result = runResult({
    declinedBytes: outsideA.bytes + outsideB.bytes + locked.bytes,
    results: [
      { candidateId: outsideA.id, status: "declined", bytes: outsideA.bytes, reason: "outside-allowed-root" },
      { candidateId: outsideB.id, status: "declined", bytes: outsideB.bytes, reason: "outside-allowed-root" },
      { candidateId: locked.id, status: "declined", bytes: locked.bytes, reason: "locked" },
    ],
  });

  const stream = sink();
  printResult(result, built, stream);
  const text = stream.text();

  assert.match(text, /left alone/i);
  assert.match(text, /outside your folders \(x2\)/);
  assert.match(text, /locked/);
  assert.ok(!text.includes(outsideA.id) && !text.includes(outsideB.id) && !text.includes(locked.id), "blocker ids must never appear as raw prose");
});

test("printResult: a genuine failure is called out separately from routine skips, in plain words", () => {
  const failedCandidate = candidate();
  const built = plan([failedCandidate]);
  const result = runResult({
    failedBytes: failedCandidate.bytes,
    results: [{ candidateId: failedCandidate.id, status: "failed", bytes: failedCandidate.bytes, reason: "spawn uv ENOENT" }],
  });

  const stream = sink();
  printResult(result, built, stream);
  const text = stream.text();

  assert.match(text, /could not be removed/i);
  assert.match(text, /isn't installed/i);
  assert.ok(!text.includes("ENOENT"), "the raw errno must be translated, never shown verbatim");
});

test("printResult: a candidate missing from the plan (e.g. --json round-trip drift) falls back to its id rather than crashing", () => {
  const orphanId = "orphan-candidate-id";
  const result = runResult({
    deletedBytes: 42,
    results: [{ candidateId: orphanId, status: "deleted", bytes: 42 }],
  });
  const stream = sink();
  assert.doesNotThrow(() => printResult(result, plan([]), stream));
  assert.match(stream.text(), new RegExp(orphanId));
});

// ---------------------------------------------------------------------------
// plainRestore: sanity that every category still says something, since
// checklist.ts renders this unconditionally for every row.
// ---------------------------------------------------------------------------

test("plainRestore: irreplaceable always reads as 'cannot be undone', regardless of category", () => {
  assert.equal(plainRestore({ provider: "test", category: "ai-history", restoreMethod: "", tier: "irreplaceable" }), "cannot be undone");
});

test("formatBytes: sanity on the units boundary", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(10 * 1024 ** 3), "10 GB");
});
