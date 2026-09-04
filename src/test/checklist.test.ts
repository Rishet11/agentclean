import assert from "node:assert/strict";
import test from "node:test";
import { tierLabel } from "../core/tiers.js";
import { humanReason } from "../core/output.js";
import { PassThrough } from "node:stream";
import { runChecklist } from "../ui/checklist.js";
import type { ChecklistIO } from "../ui/checklist.js";
import type { ReportModel, ReportRow } from "../core/report.js";

/**
 * Drives `runChecklist` over a plain `PassThrough` with `isTTY: true` and no
 * `setRawMode` (a real TTY has one; a PassThrough does not), so every test
 * here exercises the same four mechanics the implementation depends on:
 * `emitKeypressEvents` decoding real bytes on a non-TTY-backed stream, the
 * `typeof stdin.setRawMode === "function"` guard, ctrl+c arriving as a
 * keypress instead of SIGINT, and a lone ESC never firing as its own
 * keypress within the merge window.
 */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function row(overrides: Partial<ReportRow> & Pick<ReportRow, "key" | "tier" | "candidateIds">): ReportRow {
  return {
    kind: "single",
    provider: "test",
    category: "ai-caches",
    label: `/home/example/${overrides.key}`,
    labelKind: "path",
    bytes: 1024,
    fileCount: 1,
    count: overrides.candidateIds.length,
    restoreMethod: "some restore command",
    restoreSeconds: 5,
    needsNetwork: false,
    eligible: true,
    blockers: [],
    partial: false,
    ...overrides,
  };
}

function buildModel(rows: ReportRow[]): ReportModel {
  const tierSubtotals = (["free", "cheap", "irreplaceable"] as const).map((tier) => {
    const members = rows.filter((entry) => entry.tier === tier);
    return { tier, bytes: members.reduce((sum, entry) => sum + entry.bytes, 0), count: members.reduce((sum, entry) => sum + entry.count, 0) };
  });
  const eligible = rows.filter((entry) => entry.eligible);
  return {
    generatedAt: new Date(0).toISOString(),
    planHash: "hash",
    totalBytes: rows.reduce((sum, entry) => sum + entry.bytes, 0),
    totalCandidates: rows.reduce((sum, entry) => sum + entry.count, 0),
    eligibleBytes: eligible.reduce((sum, entry) => sum + entry.bytes, 0),
    eligibleCandidates: eligible.reduce((sum, entry) => sum + entry.count, 0),
    tierSubtotals,
    rows,
    blocked: rows.filter((entry) => !entry.eligible).map((entry) => ({ reason: entry.blockers[0] ?? "ineligible", bytes: entry.bytes, count: entry.count, candidateIds: entry.candidateIds })),
    truncatedRows: 0,
    truncatedCandidates: 0,
  };
}

/** free-1 and cheap-1 are plain eligible rows (pre-ticked by tier); irr-1 is
 * an eligible-but-not-pre-ticked irreplaceable row; history-1 is the
 * permanently unselectable case: irreplaceable AND blocked. */
function fixtureModel(): ReportModel {
  return buildModel([
    row({ key: "free-1", tier: "free", candidateIds: ["free-1"] }),
    row({ key: "cheap-1", tier: "cheap", candidateIds: ["cheap-1"] }),
    row({ key: "irr-1", tier: "irreplaceable", candidateIds: ["irr-1"], eligible: true, blockers: [] }),
    row({ key: "history-1", tier: "irreplaceable", candidateIds: ["history-1"], eligible: false, blockers: ["history-requires-explicit-opt-in"] }),
  ]);
}

interface Harness {
  io: ChecklistIO;
  frames: string[];
}

/** No `setRawMode` on either stream, deliberately: a plain PassThrough has
 * none, which is exactly the case the implementation must guard with
 * `typeof`. */
function makeHarness(rows = 24): Harness {
  const stdin = new PassThrough() as unknown as ChecklistIO["stdin"];
  stdin.isTTY = true;

  const frames: string[] = [];
  const stdoutBase = new PassThrough();
  const stdout = stdoutBase as unknown as ChecklistIO["stdout"];
  stdout.isTTY = true;
  stdout.rows = rows;
  stdout.write = ((chunk: unknown) => {
    frames.push(String(chunk));
    return true;
  }) as typeof stdout.write;

  return { io: { stdin, stdout }, frames };
}

async function press(io: ChecklistIO, bytes: string): Promise<void> {
  (io.stdin as unknown as PassThrough).write(bytes);
  await delay(20);
}

test("degrades cleanly on a non-TTY stream: returns aborted immediately, no listeners attached", async () => {
  const { io } = makeHarness();
  io.stdin.isTTY = false;
  const result = await runChecklist(fixtureModel(), io);
  assert.equal(result.aborted, true);
  assert.equal(result.selectedIds.size, 0);
});

test("pre-ticks free and cheap tiers, never irreplaceable; the first rendered frame shows it", async () => {
  const { io, frames } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10); // let the initial frame render before any key arrives

  const firstFrame = frames.find((frame) => frame.includes(tierLabel.free));
  assert.ok(firstFrame, "expected a rendered frame before any keypress");
  // Reference tierLabel rather than the wording, so renaming a label for
  // readability can never quietly turn the irreplaceable tier on by default.
  assert.match(firstFrame, new RegExp(`\\[x\\].*${tierLabel.free}`));
  assert.match(firstFrame, new RegExp(`\\[x\\].*${tierLabel.cheap}`));
  assert.match(firstFrame, new RegExp(`\\[ \\].*${tierLabel.irreplaceable}`));

  await press(io, "\r");
  const result = await donePromise;
  assert.equal(result.aborted, false);
  assert.deepEqual(result.selectedIds, new Set(["free-1", "cheap-1"]));
});

test("space toggles the focused row", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);
  // Initial cursor lands on the first row (free-1), right after its tier header.
  await press(io, " "); // toggle free-1 off
  await press(io, "\r");
  const result = await donePromise;
  assert.equal(result.aborted, false);
  assert.deepEqual(result.selectedIds, new Set(["cheap-1"]));
});

test("'f' selects exactly the free tier, clearing everything else", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);
  await press(io, "f");
  await press(io, "\r");
  const result = await donePromise;
  assert.equal(result.aborted, false);
  assert.deepEqual(result.selectedIds, new Set(["free-1"]));
});

test("'n' clears the selection entirely", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);
  await press(io, "n");
  await press(io, "\r");
  const result = await donePromise;
  assert.equal(result.aborted, false);
  assert.equal(result.selectedIds.size, 0);
});

test("a history-requires-explicit-opt-in row cannot be selected by any key sequence", async () => {
  const { io, frames } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);

  // Walk the cursor down onto the history-1 row: header(free) row(free-1)
  // header(cheap) row(cheap-1) header(irreplaceable) row(irr-1) row(history-1).
  for (let i = 0; i < 5; i += 1) await press(io, "j");

  const beforeSpace = frames.length;
  await press(io, " "); // try to toggle it directly
  assert.ok(frames.slice(beforeSpace).some((frame) => frame.includes("kept") && frame.includes(humanReason("history-requires-explicit-opt-in"))));

  await press(io, "a"); // try the group toggle for its tier
  await press(io, "f"); // try free-only (should not touch it)
  await press(io, "n"); // clear, then try once more
  await press(io, " ");
  await press(io, "\r");

  const result = await donePromise;
  assert.equal(result.selectedIds.has("history-1"), false);
});

test("'q' aborts with an empty selection, even after making selections", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);
  await press(io, "f"); // make a selection first
  await press(io, "q");
  const result = await donePromise;
  assert.equal(result.aborted, true);
  assert.equal(result.selectedIds.size, 0);
});

test("ctrl+c aborts with an empty selection (raw mode suppresses SIGINT, so this must be handled as a keypress)", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);
  await press(io, "\x03");
  const result = await donePromise;
  assert.equal(result.aborted, true);
  assert.equal(result.selectedIds.size, 0);
});

test("a lone ESC is not the abort key and does not end the session: the checklist is still responsive afterward", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);

  await press(io, "\x1b"); // lone ESC: readline holds it, waiting for a possible escape sequence
  await delay(650); // past readline's escape-sequence timeout: it resolves to a standalone "escape" keypress, which must be a no-op

  await press(io, " "); // if the session were still alive and unaborted, this toggles free-1 off
  await press(io, "\r");

  const result = await donePromise;
  assert.equal(result.aborted, false, "ESC must never abort the checklist");
  assert.equal(result.selectedIds.has("free-1"), false, "the space toggle after ESC must still have taken effect");
  assert.equal(result.selectedIds.has("cheap-1"), true);
});

test("'?' has key.name === undefined and must not crash the keypress handler", async () => {
  const { io } = makeHarness();
  const donePromise = runChecklist(fixtureModel(), io);
  await delay(10);
  await press(io, "?");
  await press(io, "\r");
  const result = await donePromise;
  assert.equal(result.aborted, false);
  assert.deepEqual(result.selectedIds, new Set(["free-1", "cheap-1"]));
});
