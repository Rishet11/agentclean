import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRunId,
  decideQuarantine,
  metadataPathFor,
  purgeExpired,
  purgeRun,
  quarantineBudgetBytes,
  quarantineCandidate,
  quarantinedBytesFor,
  readQuarantineMetadata,
  restoreRun,
  runQuarantineDir,
  type QuarantineDecisionContext,
} from "../core/quarantine.js";
import type { Candidate, RestoreCost } from "../core/types.js";

const GiB = 1024 ** 3;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "candidate-1",
    provider: "test",
    providerStatus: "verified",
    category: "ai-history",
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

function cost(overrides: Partial<RestoreCost>): RestoreCost {
  return { tier: "irreplaceable", seconds: "unknown", method: "", needsNetwork: false, confidence: "unknown", ...overrides };
}

function baseContext(overrides: Partial<QuarantineDecisionContext> = {}): QuarantineDecisionContext {
  return { policy: {}, freeBytes: 10 * GiB, targetDevice: 1, quarantineRootDevice: 1, ...overrides };
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-quarantine-")));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// decideQuarantine table
// ---------------------------------------------------------------------------

test("decideQuarantine: free tier is always direct", () => {
  const c = candidate({ restoreCost: cost({ tier: "free", method: "npm run build" }) });
  assert.equal(decideQuarantine(c, baseContext()).mode, "direct");
});

test("decideQuarantine: cheap tier with a method is direct and carries the method", () => {
  const c = candidate({ restoreCost: cost({ tier: "cheap", method: "npm ci", needsNetwork: true }) });
  const decision = decideQuarantine(c, baseContext());
  assert.equal(decision.mode, "direct");
  assert.match(decision.reason, /npm ci/);
});

test("decideQuarantine: cheap tier with no method falls through to quarantine", () => {
  const c = candidate({ bytes: GiB, restoreCost: cost({ tier: "cheap", method: "" }) });
  assert.equal(decideQuarantine(c, baseContext()).mode, "quarantine");
});

test("decideQuarantine: provider-command candidates are direct (external tool removes it)", () => {
  const c = candidate({
    action: "provider-command",
    target: { kind: "command", command: ["uv", "cache", "prune"] },
    restoreCost: cost({ tier: "cheap", method: "refills on the next uv install", needsNetwork: true }),
  });
  const decision = decideQuarantine(c, baseContext());
  assert.equal(decision.mode, "direct");
  assert.match(decision.reason, /refills on the next uv install/);
});

test("decideQuarantine: a non-path delete target (defensive) is also direct", () => {
  const c = candidate({ target: { kind: "command", command: ["git", "worktree", "remove", "x"] } });
  assert.equal(decideQuarantine(c, baseContext()).mode, "direct");
});

test("decideQuarantine: irreplaceable within budget quarantines", () => {
  const c = candidate({ bytes: GiB, restoreCost: cost({ tier: "irreplaceable" }) });
  assert.equal(decideQuarantine(c, baseContext()).mode, "quarantine");
});

test("decideQuarantine: over budget refuses (and does not delete)", () => {
  const c = candidate({ bytes: 5 * GiB, restoreCost: cost({ tier: "irreplaceable" }) });
  // budget = min(2 GiB, 0.2 * 1 GiB) = 0.2 GiB, candidate is 5 GiB.
  const decision = decideQuarantine(c, baseContext({ freeBytes: 1 * GiB }));
  assert.equal(decision.mode, "refuse");
  assert.match(decision.reason, /budget/);
});

test("decideQuarantine: already-committed bytes count against the budget", () => {
  const c = candidate({ bytes: 100 * 1024 * 1024, restoreCost: cost({ tier: "irreplaceable" }) });
  const budget = quarantineBudgetBytes({}, 1 * GiB); // ~0.2 GiB
  const decision = decideQuarantine(c, baseContext({ freeBytes: 1 * GiB, committedBytes: budget }));
  assert.equal(decision.mode, "refuse");
});

test("decideQuarantine: cross-device target refuses", () => {
  const c = candidate({ restoreCost: cost({ tier: "irreplaceable" }) });
  const decision = decideQuarantine(c, baseContext({ targetDevice: 1, quarantineRootDevice: 2 }));
  assert.equal(decision.mode, "refuse");
  assert.match(decision.reason, /device/);
});

test("decideQuarantine: noQuarantine + irreplaceable refuses", () => {
  const c = candidate({ restoreCost: cost({ tier: "irreplaceable" }) });
  const decision = decideQuarantine(c, baseContext({ noQuarantine: true }));
  assert.equal(decision.mode, "refuse");
});

test("quarantineBudgetBytes: lesser of policy cap and 20% of free space", () => {
  assert.equal(quarantineBudgetBytes({ quarantineMaxBytes: 1 * GiB }, 100 * GiB), 1 * GiB);
  assert.equal(quarantineBudgetBytes({}, 1 * GiB), Math.floor(0.2 * GiB));
  assert.equal(quarantineBudgetBytes(undefined, 0), 0);
});

// ---------------------------------------------------------------------------
// Round trip + interrupted run + corruption
// ---------------------------------------------------------------------------

test("round trip: original gone, quarantine copy byte-identical, restore puts it back; second restore conflicts", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");
    const workDir = path.join(root, "work");
    await mkdir(workDir, { recursive: true });
    const targetPath = path.join(workDir, "irreplaceable.txt");
    const content = "byte-identical-payload-".repeat(500);
    await writeFile(targetPath, content, "utf8");

    const runId = createRunId();
    const c = candidate({ id: "cand-a", target: { kind: "path", path: targetPath }, bytes: Buffer.byteLength(content) });

    const move = await quarantineCandidate(c, { stateDir, runId });
    assert.equal(move.ok, true);
    assert.ok(move.entry);

    await assert.rejects(stat(targetPath));
    const quarantinedContent = await readFile(move.entry!.quarantinePath, "utf8");
    assert.equal(quarantinedContent, content);

    const restore1 = await restoreRun(stateDir, runId);
    assert.equal(restore1.restored.length, 1);
    assert.equal(restore1.restoredBytes, Buffer.byteLength(content));
    assert.equal(restore1.conflicts.length, 0);
    assert.equal(await readFile(targetPath, "utf8"), content);

    const restore2 = await restoreRun(stateDir, runId);
    assert.equal(restore2.restored.length, 0);
    assert.equal(restore2.conflicts.length, 1);
    assert.equal(restore2.conflicts[0].originalPath, targetPath);
    // must not have been overwritten a second time
    assert.equal(await readFile(targetPath, "utf8"), content);
  });
});

test("restoreRun('last') resolves the most recently created run", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");
    const workDir = path.join(root, "work");
    await mkdir(workDir, { recursive: true });

    const olderPath = path.join(workDir, "older.txt");
    await writeFile(olderPath, "older", "utf8");
    await quarantineCandidate(candidate({ id: "older", target: { kind: "path", path: olderPath }, bytes: 5 }), { stateDir, runId: "run-older", now: 1000 });

    const newerPath = path.join(workDir, "newer.txt");
    await writeFile(newerPath, "newer", "utf8");
    await quarantineCandidate(candidate({ id: "newer", target: { kind: "path", path: newerPath }, bytes: 5 }), { stateDir, runId: "run-newer", now: 2000 });

    const result = await restoreRun(stateDir, "last");
    assert.equal(result.runId, "run-newer");
    assert.equal(result.restored.length, 1);
    assert.equal(result.restored[0].candidateId, "newer");
  });
});

test("interrupted run: metadata rewritten after each item stays valid JSON describing what actually moved", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");
    const workDir = path.join(root, "work");
    await mkdir(workDir, { recursive: true });
    const pathA = path.join(workDir, "a.txt");
    const pathB = path.join(workDir, "b.txt");
    await writeFile(pathA, "a-content", "utf8");
    await writeFile(pathB, "b-content", "utf8");

    const runId = createRunId();
    const first = await quarantineCandidate(candidate({ id: "cand-a", target: { kind: "path", path: pathA }, bytes: 9 }), { stateDir, runId });
    assert.equal(first.ok, true);

    // "Interruption" happens right here: only one of two items has moved so far.
    const raw = await readFile(metadataPathFor(stateDir, runId), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
    const mid = await readQuarantineMetadata(stateDir, runId);
    assert.ok(mid);
    assert.equal(mid!.entries.length, 1);
    assert.equal(mid!.entries[0].candidateId, "cand-a");
    assert.equal(mid!.entries[0].quarantinePath, first.entry!.quarantinePath);

    const second = await quarantineCandidate(candidate({ id: "cand-b", target: { kind: "path", path: pathB }, bytes: 9 }), { stateDir, runId });
    assert.equal(second.ok, true);
    const final = await readQuarantineMetadata(stateDir, runId);
    assert.equal(final!.entries.length, 2);
  });
});

test("corrupt or missing quarantine.json degrades to nothing to restore, never throws", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");

    const missingRun = await restoreRun(stateDir, "no-such-run");
    assert.deepEqual(missingRun, { runId: "no-such-run", restored: [], conflicts: [], missing: [], failed: [], restoredBytes: 0 });

    const runId = "corrupt-run";
    await mkdir(runQuarantineDir(stateDir, runId), { recursive: true });
    await writeFile(metadataPathFor(stateDir, runId), "{ not valid json at all", "utf8");
    const corrupt = await restoreRun(stateDir, runId);
    assert.deepEqual(corrupt.restored, []);
    assert.equal(await readQuarantineMetadata(stateDir, runId), undefined);

    const lastWithNothing = await restoreRun(stateDir, "last");
    assert.equal(lastWithNothing.runId, undefined);
    assert.deepEqual(lastWithNothing.restored, []);

    // purgeExpired must not throw walking over the corrupt run either.
    const purge = await purgeExpired(stateDir, Date.now());
    assert.equal(purge.removedEntries, 0);
  });
});

// ---------------------------------------------------------------------------
// purgeExpired / purgeRun
// ---------------------------------------------------------------------------

test("purgeExpired removes an entry past purgeAfter and reports the bytes; leaves a fresh one alone", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");
    const workDir = path.join(root, "work");
    await mkdir(workDir, { recursive: true });
    const now = Date.now();

    const expiredContent = "expired-content";
    const expiredPath = path.join(workDir, "expired.txt");
    await writeFile(expiredPath, expiredContent, "utf8");
    const expiredMove = await quarantineCandidate(candidate({ id: "expired-cand", target: { kind: "path", path: expiredPath }, bytes: Buffer.byteLength(expiredContent) }), {
      stateDir,
      runId: "run-expired",
      now: now - 10 * 86_400_000,
      retentionDays: 7,
    });
    assert.equal(expiredMove.ok, true);

    const freshContent = "fresh-content";
    const freshPath = path.join(workDir, "fresh.txt");
    await writeFile(freshPath, freshContent, "utf8");
    const freshMove = await quarantineCandidate(candidate({ id: "fresh-cand", target: { kind: "path", path: freshPath }, bytes: Buffer.byteLength(freshContent) }), {
      stateDir,
      runId: "run-fresh",
      now,
      retentionDays: 7,
    });
    assert.equal(freshMove.ok, true);

    const purge = await purgeExpired(stateDir, now);
    assert.equal(purge.removedEntries, 1);
    assert.equal(purge.removedBytes, Buffer.byteLength(expiredContent));
    assert.deepEqual(purge.runsCleared, ["run-expired"]);

    assert.equal(await readQuarantineMetadata(stateDir, "run-expired"), undefined);
    const freshMeta = await readQuarantineMetadata(stateDir, "run-fresh");
    assert.ok(freshMeta);
    assert.equal(freshMeta!.entries.length, 1);
    assert.equal(quarantinedBytesFor(freshMeta!), Buffer.byteLength(freshContent));
  });
});

test("purgeExpired hard cap evicts oldest survivors first when the total exceeds it", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");
    const workDir = path.join(root, "work");
    await mkdir(workDir, { recursive: true });
    const now = Date.now();
    const size = 3 * 1024 * 1024; // 3 MB each

    const paths = ["one.bin", "two.bin", "three.bin"].map((name) => path.join(workDir, name));
    for (const p of paths) await writeFile(p, Buffer.alloc(size, 1));

    // quarantinedAt order: one (oldest) -> two -> three (newest), none expired by purgeAfter.
    await quarantineCandidate(candidate({ id: "one", target: { kind: "path", path: paths[0] }, bytes: size }), { stateDir, runId: "run-a", now: now - 300, retentionDays: 30 });
    await quarantineCandidate(candidate({ id: "two", target: { kind: "path", path: paths[1] }, bytes: size }), { stateDir, runId: "run-a", now: now - 200, retentionDays: 30 });
    await quarantineCandidate(candidate({ id: "three", target: { kind: "path", path: paths[2] }, bytes: size }), { stateDir, runId: "run-a", now: now - 100, retentionDays: 30 });

    // Cap smaller than the total (9 MB) but big enough for the newest one (3 MB) alone.
    const purge = await purgeExpired(stateDir, now, { totalCapBytes: 4 * 1024 * 1024 });
    assert.equal(purge.removedEntries, 2);
    assert.equal(purge.removedBytes, 2 * size);

    const meta = await readQuarantineMetadata(stateDir, "run-a");
    assert.ok(meta);
    assert.equal(meta!.entries.length, 1);
    assert.equal(meta!.entries[0].candidateId, "three");
  });
});

test("purgeRun purges a run unconditionally, ignoring purgeAfter", async () => {
  await withTempDir(async (root) => {
    const stateDir = path.join(root, "state");
    const workDir = path.join(root, "work");
    await mkdir(workDir, { recursive: true });
    const p = path.join(workDir, "item.txt");
    await writeFile(p, "content", "utf8");
    await quarantineCandidate(candidate({ id: "item", target: { kind: "path", path: p }, bytes: 7 }), { stateDir, runId: "run-x", retentionDays: 365 });

    const purge = await purgeRun(stateDir, "run-x");
    assert.equal(purge.removedEntries, 1);
    assert.equal(purge.removedBytes, 7);
    assert.deepEqual(purge.runsCleared, ["run-x"]);
    assert.equal(await readQuarantineMetadata(stateDir, "run-x"), undefined);
  });
});
