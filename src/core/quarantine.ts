import { lstat, link, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candidate, Fingerprint } from "./types.js";
import { fingerprintFromStats } from "./types.js";
import { isWithin } from "./paths.js";

/**
 * Undo for the class of deletion that has no other undo.
 *
 * `rename` frees zero bytes: moving a directory into a holding area on the
 * same filesystem does not touch free space, it only relocates where the
 * bytes live. That is exactly why this module exists (undo without needing
 * headroom the disk does not have) and exactly why it is not a blanket
 * "move everything to a bin" — see decideQuarantine, which sends `free` and
 * `cheap`-with-a-known-method candidates straight to direct deletion instead.
 */

const DEFAULT_MAX_QUARANTINE_BYTES = 2 * 1024 ** 3; // 2 GiB
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_TOTAL_CAP_BYTES = 4 * 1024 ** 3; // 4 GiB
const FREE_BYTES_BUDGET_FRACTION = 0.2;
const SCHEMA_VERSION = 1 as const;

function formatBytesLocal(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// 1. decideQuarantine: pure, table-testable
// ---------------------------------------------------------------------------

export type QuarantineMode = "direct" | "quarantine" | "refuse";

export interface QuarantineDecision {
  mode: QuarantineMode;
  reason: string;
}

/**
 * The subset of Policy this module cares about. Kept as its own shape
 * (rather than importing Policy from types.ts) since Policy is owned by
 * someone else and does not declare these fields yet; whoever wires this in
 * can widen Policy to include them and pass it straight through, since a
 * wider object still satisfies this shape structurally.
 */
export interface QuarantinePolicyLike {
  quarantineMaxBytes?: number;
  quarantineRetentionDays?: number;
  quarantineTotalCapBytes?: number;
}

export interface QuarantineDecisionContext {
  policy?: QuarantinePolicyLike;
  /** Bytes free on the quarantine root's filesystem right now (see freeBytesFor). */
  freeBytes: number;
  /** Bytes already committed to quarantine that must count against the budget (earlier items this run). */
  committedBytes?: number;
  /** lstat().dev of the target, or its nearest existing ancestor (see nearestExistingAncestorDevice). */
  targetDevice: number;
  /** lstat().dev of the quarantine root, or its nearest existing ancestor. */
  quarantineRootDevice: number;
  /** Caller opted out of quarantine entirely (e.g. --no-quarantine). */
  noQuarantine?: boolean;
}

export function quarantineBudgetBytes(policy: QuarantinePolicyLike | undefined, freeBytes: number): number {
  const configuredCap = policy?.quarantineMaxBytes ?? DEFAULT_MAX_QUARANTINE_BYTES;
  const freeShare = Math.floor(Math.max(0, freeBytes) * FREE_BYTES_BUDGET_FRACTION);
  return Math.min(configuredCap, freeShare);
}

/**
 * Evaluated in order (see the module doc and the tool's design notes):
 *   1. not a delete-a-path candidate -> direct (external tool removes it; we cannot intercept it)
 *   2. free tier -> direct (rebuilding is the real undo; quarantining wastes the reclaimed space)
 *   3. cheap tier with a known method -> direct (carry the method for display)
 *   4. otherwise (irreplaceable, or cheap with no method) -> quarantine, unless:
 *        - noQuarantine was requested -> refuse
 *        - target and quarantine root are on different devices -> refuse
 *        - the item would exceed the quarantine budget -> refuse
 *
 * When quarantine cannot hold an item, the item is refused, not deleted: this
 * extends "we do not delete what we cannot prove we own" to "we do not
 * delete what we cannot give back".
 */
export function decideQuarantine(candidate: Candidate, context: QuarantineDecisionContext): QuarantineDecision {
  if (candidate.action !== "delete" || candidate.target.kind !== "path") {
    return {
      mode: "direct",
      reason: candidate.restoreCost?.method ? `an external tool performs this removal; restore is ${candidate.restoreCost.method}` : "an external tool performs this removal; we cannot intercept it",
    };
  }

  const tier = candidate.restoreCost?.tier;
  if (tier === "free") {
    return { mode: "direct", reason: "free tier: rebuilding is the real undo; quarantining would consume exactly the space being reclaimed" };
  }
  if (tier === "cheap" && candidate.restoreCost && candidate.restoreCost.method) {
    return { mode: "direct", reason: `cheap tier with a known restore path: ${candidate.restoreCost.method}` };
  }

  // Otherwise: irreplaceable, or cheap with no verified method. Never assume
  // a way back exists that we cannot see evidence for (mirrors tiers.ts).
  if (context.noQuarantine) {
    return { mode: "refuse", reason: "quarantine disabled for this run and this item has no other restore path" };
  }
  if (context.targetDevice !== context.quarantineRootDevice) {
    return { mode: "refuse", reason: "target and quarantine root are on different devices; a same-device rename is impossible and copy-then-delete is refused on principle" };
  }
  const budget = quarantineBudgetBytes(context.policy, context.freeBytes);
  const committed = context.committedBytes ?? 0;
  if (committed + candidate.bytes > budget) {
    return {
      mode: "refuse",
      reason: `quarantine budget of ${formatBytesLocal(budget)} exceeded (the lesser of the policy cap and 20% of free space); this item alone is ${formatBytesLocal(candidate.bytes)}`,
    };
  }
  return { mode: "quarantine", reason: "irreplaceable (or cheap with no verified restore path); moving to quarantine within budget" };
}

// ---------------------------------------------------------------------------
// Filesystem helpers used to build a QuarantineDecisionContext
// ---------------------------------------------------------------------------

export async function freeBytesFor(targetPath: string): Promise<number> {
  const stats = await statfs(targetPath);
  return stats.bavail * stats.bsize;
}

/** Walks up to the nearest existing ancestor and returns its device id, or undefined if none exists (e.g. root is unreadable). */
export async function nearestExistingAncestorDevice(target: string): Promise<number | undefined> {
  let current = path.resolve(target);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const stats = await lstat(current);
      return stats.dev;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Storage: <stateDir>/quarantine/<runId>/<candidateId>/<basename>
// ---------------------------------------------------------------------------

export interface QuarantineEntry {
  candidateId: string;
  provider: string;
  category: string;
  originalPath: string;
  quarantinePath: string;
  bytes: number;
  fingerprint?: Fingerprint;
  quarantinedAt: string;
}

export interface QuarantineMetadata {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  purgeAfter: string;
  entries: QuarantineEntry[];
}

export function createRunId(now = Date.now()): string {
  return `run-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function quarantineRootDir(stateDir: string): string {
  return path.join(stateDir, "quarantine");
}

export function runQuarantineDir(stateDir: string, runId: string): string {
  return path.join(quarantineRootDir(stateDir), runId);
}

export function metadataPathFor(stateDir: string, runId: string): string {
  return path.join(runQuarantineDir(stateDir, runId), "quarantine.json");
}

export function candidateQuarantinePath(stateDir: string, runId: string, candidate: Candidate): string {
  const basename = candidate.target.kind === "path" ? path.basename(candidate.target.path) : candidate.id;
  return path.join(runQuarantineDir(stateDir, runId), candidate.id, basename);
}

function isValidEntry(value: unknown): value is QuarantineEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.candidateId === "string" &&
    typeof entry.provider === "string" &&
    typeof entry.category === "string" &&
    typeof entry.originalPath === "string" &&
    typeof entry.quarantinePath === "string" &&
    typeof entry.bytes === "number" &&
    typeof entry.quarantinedAt === "string"
  );
}

/** Degrades to undefined on any missing or corrupt metadata. Never throws. */
export async function readQuarantineMetadata(stateDir: string, runId: string): Promise<QuarantineMetadata | undefined> {
  try {
    const raw = await readFile(metadataPathFor(stateDir, runId), "utf8");
    const parsed = JSON.parse(raw) as Partial<QuarantineMetadata>;
    if (parsed.schemaVersion !== 1 || typeof parsed.runId !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.purgeAfter !== "string" || !Array.isArray(parsed.entries)) {
      return undefined;
    }
    return { schemaVersion: 1, runId: parsed.runId, createdAt: parsed.createdAt, purgeAfter: parsed.purgeAfter, entries: parsed.entries.filter(isValidEntry) };
  } catch {
    return undefined;
  }
}

async function writeQuarantineMetadata(stateDir: string, runId: string, metadata: QuarantineMetadata): Promise<void> {
  const dir = runQuarantineDir(stateDir, runId);
  await mkdir(dir, { recursive: true });
  const target = metadataPathFor(stateDir, runId);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

export interface QuarantineMoveOptions {
  stateDir: string;
  runId: string;
  now?: number;
  retentionDays?: number;
}

export interface QuarantineMoveResult {
  ok: boolean;
  entry?: QuarantineEntry;
  reason?: string;
}

/**
 * Moves a single candidate's target into quarantine and rewrites
 * quarantine.json immediately, so an interrupted run always leaves metadata
 * describing exactly what actually moved. Same-device rename only: checked
 * up front via nearestExistingAncestorDevice, and EXDEV is still caught at
 * runtime as a last-resort guard. Never falls back to copy-then-delete.
 */
export async function quarantineCandidate(candidate: Candidate, options: QuarantineMoveOptions): Promise<QuarantineMoveResult> {
  if (candidate.target.kind !== "path") return { ok: false, reason: "candidate has no filesystem path to quarantine" };
  const now = options.now ?? Date.now();
  const originalPath = candidate.target.path;
  const destination = candidateQuarantinePath(options.stateDir, options.runId, candidate);

  let fingerprint = candidate.fingerprint;
  if (!fingerprint) {
    try {
      fingerprint = fingerprintFromStats(await lstat(originalPath));
    } catch {
      return { ok: false, reason: "target no longer exists" };
    }
  }

  const originalDevice = await nearestExistingAncestorDevice(originalPath);
  const quarantineDevice = await nearestExistingAncestorDevice(quarantineRootDir(options.stateDir));
  if (originalDevice !== undefined && quarantineDevice !== undefined && originalDevice !== quarantineDevice) {
    return { ok: false, reason: "target and quarantine root are on different devices; refusing to copy on a full disk" };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(originalPath, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      return { ok: false, reason: "cross-device rename (EXDEV); refusing to copy on a full disk" };
    }
    return { ok: false, reason: error instanceof Error ? error.message : "rename failed" };
  }

  const entry: QuarantineEntry = {
    candidateId: candidate.id,
    provider: candidate.provider,
    category: candidate.category,
    originalPath,
    quarantinePath: destination,
    bytes: candidate.bytes,
    fingerprint,
    quarantinedAt: new Date(now).toISOString(),
  };

  const existing = (await readQuarantineMetadata(options.stateDir, options.runId)) ?? {
    schemaVersion: SCHEMA_VERSION,
    runId: options.runId,
    createdAt: new Date(now).toISOString(),
    purgeAfter: new Date(now + (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86_400_000).toISOString(),
    entries: [] as QuarantineEntry[],
  };
  existing.entries.push(entry);
  try {
    await writeQuarantineMetadata(options.stateDir, options.runId, existing);
  } catch (error) {
    // The object already moved but is not recorded anywhere: that would be an
    // orphaned copy nothing can restore or purge. Try to put it back rather
    // than accept that; if even the rollback fails, say so plainly instead
    // of reporting an ok:true a caller would trust.
    const writeReason = error instanceof Error ? error.message : "writing quarantine.json failed";
    try {
      await rename(destination, originalPath);
      return { ok: false, reason: `could not record quarantine metadata (${writeReason}); moved the item back to its original location` };
    } catch (rollbackError) {
      const rollbackReason = rollbackError instanceof Error ? rollbackError.message : "unknown error";
      return { ok: false, reason: `moved to quarantine but could not record it (${writeReason}), and moving it back also failed (${rollbackReason}); it now sits untracked at ${destination}` };
    }
  }

  return { ok: true, entry };
}

export function quarantinedBytesFor(metadata: QuarantineMetadata): number {
  return metadata.entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

// ---------------------------------------------------------------------------
// 3. restoreRun
// ---------------------------------------------------------------------------

export interface RestoreItemResult {
  candidateId: string;
  originalPath: string;
  status: "restored" | "conflict" | "missing" | "failed";
  bytes: number;
  reason?: string;
}

export interface RestoreRunResult {
  runId?: string;
  restored: RestoreItemResult[];
  conflicts: RestoreItemResult[];
  missing: RestoreItemResult[];
  failed: RestoreItemResult[];
  restoredBytes: number;
}

async function pathExists(target: string): Promise<boolean> {
  return await lstat(target).then(
    () => true,
    () => false,
  );
}

async function restoreEntry(entry: QuarantineEntry, runDir: string): Promise<RestoreItemResult> {
  const base = { candidateId: entry.candidateId, originalPath: entry.originalPath, bytes: entry.bytes };
  // The recorded quarantinePath must stay inside this run's own quarantine
  // directory; validated against the run directory we resolved for this
  // restore, never a freshly recomputed default root.
  if (!isWithin(runDir, entry.quarantinePath)) {
    return { ...base, status: "failed", reason: "recorded quarantine path escapes this run's quarantine directory; refusing" };
  }
  // Fast-path check: avoids the mkdir/rename attempt entirely in the common
  // case. Not itself race-free (see below) — a directory destination has no
  // atomic "fail if it exists" primitive in POSIX, so for directories this
  // check is the actual guard and a narrow TOCTOU window is an accepted,
  // documented limit of rename() semantics. For a plain file, the rename
  // below is replaced with an atomic link-then-unlink that genuinely cannot
  // clobber an existing destination, closing the window where it matters.
  if (await pathExists(entry.originalPath)) {
    return { ...base, status: "conflict", reason: "a file or directory already exists at the original path" };
  }
  if (!(await pathExists(entry.quarantinePath))) {
    return { ...base, status: "missing", reason: "quarantine copy is gone (already restored or purged)" };
  }
  try {
    await mkdir(path.dirname(entry.originalPath), { recursive: true });
    if (entry.fingerprint?.kind === "directory") {
      await rename(entry.quarantinePath, entry.originalPath);
    } else {
      // link() fails atomically with EEXIST if the destination now exists,
      // instead of rename()'s silent overwrite-on-collision.
      try {
        await link(entry.quarantinePath, entry.originalPath);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code === "EEXIST") {
          return { ...base, status: "conflict", reason: "a file or directory already exists at the original path" };
        }
        throw linkError;
      }
      await rm(entry.quarantinePath, { force: true });
    }
    return { ...base, status: "restored" };
  } catch (error) {
    return { ...base, status: "failed", reason: error instanceof Error ? error.message : "restore failed" };
  }
}

async function listRunIds(stateDir: string): Promise<string[]> {
  try {
    const dirents = await readdir(quarantineRootDir(stateDir), { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

async function resolveRunId(stateDir: string, runId: string | "last"): Promise<string | undefined> {
  if (runId !== "last") return runId;
  let latest: { id: string; createdAt: number } | undefined;
  for (const id of await listRunIds(stateDir)) {
    const meta = await readQuarantineMetadata(stateDir, id);
    if (!meta) continue;
    const createdAt = Date.parse(meta.createdAt);
    if (Number.isNaN(createdAt)) continue;
    if (!latest || createdAt > latest.createdAt) latest = { id, createdAt };
  }
  return latest?.id;
}

/**
 * Restores every entry of a quarantined run. Missing or corrupt
 * quarantine.json (or a "last" that resolves to nothing) degrades to an
 * empty result, never throws. Each entry that now conflicts with something
 * at its original path is reported, never overwritten.
 */
export async function restoreRun(stateDir: string, runId: string | "last"): Promise<RestoreRunResult> {
  const resolved = await resolveRunId(stateDir, runId);
  const empty: RestoreRunResult = { runId: resolved, restored: [], conflicts: [], missing: [], failed: [], restoredBytes: 0 };
  if (!resolved) return empty;
  const metadata = await readQuarantineMetadata(stateDir, resolved);
  if (!metadata) return empty;

  const runDir = runQuarantineDir(stateDir, resolved);
  const result = empty;
  for (const entry of metadata.entries) {
    const item = await restoreEntry(entry, runDir);
    if (item.status === "restored") {
      result.restored.push(item);
      result.restoredBytes += item.bytes;
    } else if (item.status === "conflict") result.conflicts.push(item);
    else if (item.status === "missing") result.missing.push(item);
    else result.failed.push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 4. purgeExpired / purgeRun
// ---------------------------------------------------------------------------

export interface PurgeResult {
  removedBytes: number;
  removedEntries: number;
  /** runIds whose quarantine directory was fully removed. */
  runsCleared: string[];
}

async function removeQuarantineObject(entry: QuarantineEntry): Promise<boolean> {
  try {
    await rm(entry.quarantinePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Returns true only when the run directory is actually gone afterward, so callers never report a run as cleared when it was not. */
async function removeRunDir(stateDir: string, runId: string): Promise<boolean> {
  const dir = runQuarantineDir(stateDir, runId);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return !(await pathExists(dir));
}

/**
 * Safe to call at the start of every run: expires runs past their
 * `purgeAfter`, then (if a hard total cap is still exceeded) evicts the
 * oldest remaining entries across all runs until it is not. Corrupt or
 * unreadable run metadata is left untouched rather than guessed at.
 */
export async function purgeExpired(stateDir: string, now = Date.now(), options: { totalCapBytes?: number } = {}): Promise<PurgeResult> {
  let removedBytes = 0;
  let removedEntries = 0;
  const runsCleared: string[] = [];
  const survivors = new Map<string, QuarantineMetadata>();

  for (const runId of await listRunIds(stateDir)) {
    const meta = await readQuarantineMetadata(stateDir, runId);
    if (!meta) continue;
    if (Date.parse(meta.purgeAfter) <= now) {
      for (const entry of meta.entries) {
        if (await removeQuarantineObject(entry)) {
          removedBytes += entry.bytes;
          removedEntries += 1;
        }
      }
      if (await removeRunDir(stateDir, runId)) runsCleared.push(runId);
    } else {
      survivors.set(runId, meta);
    }
  }

  const cap = options.totalCapBytes ?? DEFAULT_TOTAL_CAP_BYTES;
  const ordered: Array<{ runId: string; entry: QuarantineEntry }> = [];
  for (const [runId, meta] of survivors) for (const entry of meta.entries) ordered.push({ runId, entry });
  ordered.sort((a, b) => Date.parse(a.entry.quarantinedAt) - Date.parse(b.entry.quarantinedAt));

  let total = ordered.reduce((sum, item) => sum + item.entry.bytes, 0);
  const evictedByRun = new Map<string, Set<string>>();
  for (const { runId, entry } of ordered) {
    if (total <= cap) break;
    if (await removeQuarantineObject(entry)) {
      removedBytes += entry.bytes;
      removedEntries += 1;
    }
    total -= entry.bytes;
    if (!evictedByRun.has(runId)) evictedByRun.set(runId, new Set());
    evictedByRun.get(runId)!.add(entry.candidateId);
  }

  for (const [runId, evictedIds] of evictedByRun) {
    const meta = survivors.get(runId);
    if (!meta) continue;
    const keep = meta.entries.filter((entry) => !evictedIds.has(entry.candidateId));
    if (keep.length === 0) {
      if (await removeRunDir(stateDir, runId)) runsCleared.push(runId);
    } else {
      await writeQuarantineMetadata(stateDir, runId, { ...meta, entries: keep });
    }
  }

  return { removedBytes, removedEntries, runsCleared };
}

/** Purges one run unconditionally (e.g. an explicit "empty the quarantine for run X" request), ignoring purgeAfter. */
export async function purgeRun(stateDir: string, runId: string): Promise<PurgeResult> {
  const meta = await readQuarantineMetadata(stateDir, runId);
  if (!meta) {
    const cleared = await removeRunDir(stateDir, runId);
    return { removedBytes: 0, removedEntries: 0, runsCleared: cleared ? [runId] : [] };
  }
  let removedBytes = 0;
  let removedEntries = 0;
  for (const entry of meta.entries) {
    if (await removeQuarantineObject(entry)) {
      removedBytes += entry.bytes;
      removedEntries += 1;
    }
  }
  const cleared = await removeRunDir(stateDir, runId);
  return { removedBytes, removedEntries, runsCleared: cleared ? [runId] : [] };
}
