import type { Plan, ProviderDetection, RunResult } from "./types.js";
import { categoryLabel } from "./policy.js";
import { displayPath } from "./paths.js";
import { buildReport, type ReportRow } from "./report.js";
import { tierLabel } from "./tiers.js";
import type { RestoreTier } from "./types.js";
import { bold, colorEnabled, dim, gray } from "../ui/style.js";
import { formatDuration, padRight, truncateToWidth } from "../ui/layout.js";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const LARGEST_ITEMS_SHOWN = 15;
const NOT_DELETABLE_SHOWN = 10;

// A local, ASCII-only paraphrase of tiers.ts's tierSentence (which uses an
// em-dash): this printer commits to plain ASCII, no emoji, no box-drawing.
const TIER_SENTENCE_ASCII: Record<RestoreTier, string> = {
  free: "offline, seconds each",
  cheap: "needs network or a rebuild step, usually minutes",
  irreplaceable: "no way back, review before deleting",
};

function labelFor(row: ReportRow): string {
  const label = row.labelKind === "path" ? displayPath(row.label) : row.label;
  return truncateToWidth(label, 60);
}

function rowLine(row: ReportRow, colorOn: boolean): string {
  const size = padRight(formatBytes(row.bytes), 9);
  const suffix = row.count > 1 ? ` (x${row.count})` : "";
  const method = row.restoreMethod ? `${row.restoreMethod}, ~${formatDuration(row.restoreSeconds)}` : "no restore path";
  return `  ${size}  [${row.provider}] ${labelFor(row)}${suffix} - ${dim(method, colorOn)}`;
}

/**
 * Renders the pure `ReportModel` (see report.ts) as a plain-ASCII human page:
 * a tier roll-up, the largest items with their restore commands, blocked
 * candidates rolled up by reason, and a "where did the space go" section for
 * what can never be deleted here (irreplaceable tier, and all AI history).
 * `--json` output is wired separately (at merge time) to the same
 * `buildReport` call, so the two views are always in sync.
 */
/** Friendly one- or two-word name for a row, instead of a full command or path. */
function shortLabel(row: { provider: string; category: string; label: string; path?: string }): string {
  const caches: Record<string, string> = { uv: "uv cache", npm: "npm cache", pnpm: "pnpm store", go: "go modules", pip: "pip cache", yarn: "yarn cache", bun: "bun cache" };
  if (caches[row.provider]) return caches[row.provider];
  if (row.provider === "git") return `worktree ${basenameOf(row.label)}`;
  if (row.category === "build-artifacts") return "build output";
  if (row.category === "project-dependencies") return "node_modules";
  if (row.category === "project-environments") return "virtualenv";
  if (row.category === "ai-history") return "chat history";
  if (row.category === "ai-caches") return `${row.provider} cache`;
  return basenameOf(row.label);
}

function basenameOf(value: string): string {
  const cleaned = value.replace(/\s+refs\/heads\/.*$/, "").trim();
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

/**
 * The default view. A person with a full disk wants one screen: how much is
 * there, what the biggest wins are, what it costs to get each back, and what
 * was deliberately left alone. Everything else lives behind -v or --json.
 */
export function printSummary(plan: Plan, output: NodeJS.WritableStream): void {
  const colorOn = colorEnabled(output as { isTTY?: boolean });
  const model = buildReport(plan);
  const leftAlone = model.totalBytes - model.eligibleBytes;

  output.write("\n");
  output.write(`  ${bold(`${formatBytes(model.totalBytes)} found`, colorOn)}  ${dim("\u00b7", colorOn)}  ${bold(`${formatBytes(model.eligibleBytes)} safe to clear now`, colorOn)}\n\n`);

  const eligible = model.rows.filter((row) => row.eligible).slice(0, 5);
  for (const row of eligible) {
    output.write(`    ${padRight(formatBytes(row.bytes), 8)} ${padRight(shortLabel(row), 17)} ${dim(row.restoreMethod || "", colorOn)}\n`);
  }
  const restCount = model.rows.filter((row) => row.eligible).length - eligible.length;
  const restBytes = model.eligibleBytes - eligible.reduce((sum, row) => sum + row.bytes, 0);
  if (restCount > 0) output.write(`    ${dim(`+ ${restCount} smaller item(s), ${formatBytes(restBytes)}`, colorOn)}\n`);

  if (leftAlone > 0) {
    const reasons = model.blocked.slice(0, 3).map((entry) => humanReason(entry.reason)).join(", ");
    output.write(`\n  ${formatBytes(leftAlone)} left alone  ${dim("\u00b7", colorOn)}  ${dim(reasons || "protected", colorOn)}\n`);
  }

  output.write(`\n  ${bold("agentclean clean", colorOn)}      choose what to remove\n`);
  output.write(`  ${bold("agentclean scan -v", colorOn)}    full detail\n\n`);
}

/** Blocker ids are precise; this is what a person would say instead. */
function humanReason(reason: string): string {
  if (reason.startsWith("younger-than")) return "recently used";
  switch (reason) {
    case "history-requires-explicit-opt-in": return "chat history";
    case "dirty-or-untracked": return "unsaved work";
    case "outside-allowed-root": return "outside your folders";
    case "locked": return "locked";
    case "missing-or-prunable": return "already gone";
    default: return reason.replace(/-/g, " ");
  }
}

export function printPlan(plan: Plan, output: NodeJS.WritableStream): void {
  const colorOn = colorEnabled(output as { isTTY?: boolean });
  const model = buildReport(plan);

  output.write(`${bold(`Found ${model.totalCandidates} candidate(s), ${formatBytes(model.totalBytes)}.`, colorOn)} Plan ${plan.hash.slice(0, 12)}.\n`);
  output.write(`Eligible now: ${model.eligibleCandidates} candidate(s), ${formatBytes(model.eligibleBytes)}.\n\n`);

  output.write(`${bold("By restore cost:", colorOn)}\n`);
  for (const subtotal of model.tierSubtotals) {
    output.write(`  ${padRight(tierLabel[subtotal.tier], 20)} ${padRight(formatBytes(subtotal.bytes), 9)} ${padRight(`${subtotal.count} item(s)`, 14)} ${dim(TIER_SENTENCE_ASCII[subtotal.tier], colorOn)}\n`);
  }
  output.write("\n");

  const largest = model.rows.slice(0, LARGEST_ITEMS_SHOWN);
  if (largest.length > 0) {
    output.write(`${bold("Largest items:", colorOn)}\n`);
    for (const row of largest) output.write(`${rowLine(row, colorOn)}\n`);
    const hiddenAfterLargest = model.rows.length - largest.length;
    if (hiddenAfterLargest > 0) output.write(`  ${gray(`+ ${hiddenAfterLargest} more row(s) not shown here (see --json for all)`, colorOn)}\n`);
    output.write("\n");
  }

  if (model.blocked.length > 0) {
    output.write(`${bold("Blocked, by reason:", colorOn)}\n`);
    for (const entry of model.blocked) output.write(`  ${padRight(formatBytes(entry.bytes), 9)} ${padRight(`${entry.count} item(s)`, 14)} ${entry.reason}\n`);
    output.write("\n");
  }

  const notDeletable = model.rows.filter((row) => row.tier === "irreplaceable" || row.category === "ai-history").slice(0, NOT_DELETABLE_SHOWN);
  if (notDeletable.length > 0) {
    output.write(`${bold("Large but not ours / not deletable here:", colorOn)}\n`);
    for (const row of notDeletable) output.write(`  ${padRight(formatBytes(row.bytes), 9)} ${padRight(`[${categoryLabel(row.category)}]`, 22)} ${labelFor(row)}\n`);
    output.write("\n");
  }

  if (model.truncatedRows > 0) output.write(`${model.truncatedRows} more row(s), ${model.truncatedCandidates} candidate(s), not shown.\n`);
}

export function printProviders(detections: ProviderDetection[], output: NodeJS.WritableStream): void {
  for (const detection of detections) output.write(`${detection.id}\t${detection.status}\t${detection.details}${detection.root ? `\t${displayPath(detection.root)}` : ""}\n`);
}

export function printResult(result: RunResult, output: NodeJS.WritableStream): void {
  output.write(`Deleted: ${formatBytes(result.deletedBytes)}\nWould delete: ${formatBytes(result.wouldDeleteBytes)}\nSkipped: ${formatBytes(result.skippedBytes)}\nFailed: ${formatBytes(result.failedBytes)}\n`);
  for (const entry of result.results) if (entry.status === "skipped" || entry.status === "failed") output.write(`- ${entry.candidateId}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}\n`);
}
