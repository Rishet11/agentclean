import type { Candidate, Plan, ProviderDetection, RunResult } from "./types.js";
import { categoryLabel } from "./policy.js";
import { displayPath } from "./paths.js";
import { buildReport, type ReportRow } from "./report.js";
import { tierLabel } from "./tiers.js";
import type { RestoreTier } from "./types.js";
import { bold, colorEnabled, dim, gray, green, red, yellow } from "../ui/style.js";
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
/**
 * What a row is, in words a person who has never heard of pnpm can act on.
 * "uv cache" and "go modules" are meaningless to most people; "Python packages
 * you downloaded before" is not.
 */
export function shortLabel(row: { provider: string; category: string; label: string }): string {
  const downloads: Record<string, string> = {
    uv: "Python downloads",
    pip: "Python downloads",
    npm: "JavaScript downloads",
    pnpm: "JavaScript downloads",
    yarn: "JavaScript downloads",
    bun: "JavaScript downloads",
    go: "Go downloads",
  };
  if (downloads[row.provider]) return downloads[row.provider];
  if (row.provider === "git") return `spare copy of ${basenameOf(row.label)}`;
  switch (row.category) {
    case "build-artifacts": return `build files, ${projectOf(row.label)}`;
    case "project-dependencies": return `packages for ${projectOf(row.label)}`;
    case "project-environments": return `Python setup for ${projectOf(row.label)}`;
    case "ai-history": return "past conversations";
    case "ai-caches": return `${friendlyProvider(row.provider)} leftovers`;
    default: return basenameOf(row.label);
  }
}

/** shortLabel() takes a row-shaped `{provider, category, label}`; a raw
 * `Candidate` carries its label inside `target` instead. Same rule either way:
 * path candidates show the path, command candidates show the literal command. */
function candidateLabel(candidate: Candidate): string {
  return candidate.target.kind === "path" ? candidate.target.path : candidate.target.command.join(" ");
}

export function shortLabelForCandidate(candidate: Candidate): string {
  return shortLabel({ provider: candidate.provider, category: candidate.category, label: candidateLabel(candidate) });
}

function friendlyProvider(provider: string): string {
  switch (provider) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "cursor": return "Cursor";
    case "opencode": return "OpenCode";
    case "antigravity": return "Antigravity";
    case "gemini": return "Gemini";
    default: return provider;
  }
}

/** Keep a cell inside its column, trimming the front so the distinctive tail survives. */
function fit(value: string, width: number): string {
  return value.length <= width ? value : `\u2026${value.slice(value.length - width + 1)}`;
}

/** "…/faraway/spaceatc/frontend/dist" -> "spaceatc/frontend", the bit a person recognises. */
function projectOf(value: string): string {
  const parts = value.replace(/\s+refs\/heads\/.*$/, "").trim().split(/[\\/]/).filter(Boolean);
  const withoutArtifact = parts.slice(0, -1);
  return withoutArtifact.slice(-2).join("/") || basenameOf(value);
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

  if (model.totalCandidates === 0) {
    output.write(`\n  ${bold("Nothing to clean here.", colorOn)}\n`);
    output.write("  Either this machine is already tidy, or nothing in your usual project folders matched yet.\n");
    output.write(`  Try ${bold("agentclean scan --project-artifacts", colorOn)} to also look for node_modules, virtualenvs, and build output,\n`);
    output.write(`  or ${bold("agentclean config root add <path>", colorOn)} to point it at a folder you keep projects in.\n\n`);
    return;
  }

  const leftAlone = model.totalBytes - model.eligibleBytes;

  output.write("\n");
  output.write(`  ${bold(`${formatBytes(model.totalBytes)} found`, colorOn)}  ${dim("\u00b7", colorOn)}  ${bold(green(`${formatBytes(model.eligibleBytes)} safe to clear now`, colorOn), colorOn)}\n\n`);

  const eligible = model.rows.filter((row) => row.eligible).slice(0, 5);
  for (const row of eligible) {
    output.write(`    ${padRight(formatBytes(row.bytes), 8)} ${padRight(fit(shortLabel(row), 26), 26)} ${dim(plainRestore(row), colorOn)}\n`);
  }
  const restCount = model.rows.filter((row) => row.eligible).length - eligible.length;
  const restBytes = model.eligibleBytes - eligible.reduce((sum, row) => sum + row.bytes, 0);
  if (restCount > 0) output.write(`    ${dim(`+ ${restCount} smaller item(s), ${formatBytes(restBytes)}`, colorOn)}\n`);

  if (leftAlone > 0) {
    const reasons = model.blocked.slice(0, 3).map((entry) => humanReason(entry.reason)).join(", ");
    output.write(`\n  ${yellow(`${formatBytes(leftAlone)} left alone`, colorOn)}  ${dim("\u00b7", colorOn)}  ${dim(reasons || "protected", colorOn)}\n`);
  }

  output.write(`\n  ${bold("agentclean clean", colorOn)}      choose what to remove\n`);
  output.write(`  ${bold("agentclean scan -v", colorOn)}    full detail\n\n`);
}

/** The restore command matters to a developer; "what happens" matters to everyone. */
export function plainRestore(row: { provider: string; category: string; restoreMethod: string; tier: string }): string {
  if (row.tier === "irreplaceable") return "cannot be undone";
  switch (row.category) {
    case "package-caches": return "downloaded again when needed";
    case "build-artifacts": return "remade next time you build";
    case "project-dependencies": return "reinstalled with one command";
    case "project-environments": return "rebuilt from your requirements file";
    case "worktrees": return "your commits are kept";
    case "ai-caches": return "the app makes these again";
    default: return row.restoreMethod || "";
  }
}

/** Blocker ids are precise; this is what a person would say instead. */
export function humanReason(reason: string): string {
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

/** A blocker reason can be several joined with ", " (see executor.ts's
 * `candidate.blockers.join(", ")`); group and speak to the first (primary) one,
 * same rule report.ts's blockedRollupFor uses. */
function primaryReason(raw: string): string {
  return humanReason(raw.split(", ")[0]?.trim() || raw);
}

/**
 * Raw OS/provider errors a person actually hits, turned into a sentence that
 * says what happened. Only advice verified against this codebase's own
 * behavior is included (e.g. "run clean again" is true: nothing here resumes
 * automatically, but nothing partial is lost either, so a plain re-run picks
 * up whatever is left). Anything unrecognized passes through unchanged
 * rather than guessing.
 */
export function humanFailure(reason: string): string {
  if (/ENOSPC/.test(reason)) return "ran out of disk space partway through; free some space and run clean again to finish the rest";
  const missingCommand = /spawn (\S+) ENOENT/.exec(reason);
  if (missingCommand) return `the ${missingCommand[1]} command isn't installed, so this couldn't be cleaned up here; nothing was deleted`;
  if (/EACCES|EPERM/.test(reason)) return "no permission to remove this; it may be owned by someone else or open in another program";
  if (/^provider command exited/.test(reason)) return "the cleanup command for this reported an error";
  return reason;
}

function durationBetween(startedAt: string, finishedAt: string): string {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return "";
  return formatDuration((endMs - startMs) / 1000);
}

interface ReasonBucket {
  reason: string;
  bytes: number;
  count: number;
}

function bucketByReason(entries: Array<{ bytes: number; reason?: string }>, wordFor: (raw: string) => string): ReasonBucket[] {
  const buckets = new Map<string, ReasonBucket>();
  for (const entry of entries) {
    const reason = wordFor(entry.reason || "");
    const existing = buckets.get(reason);
    if (existing) {
      existing.bytes += entry.bytes;
      existing.count += 1;
    } else {
      buckets.set(reason, { reason, bytes: entry.bytes, count: 1 });
    }
  }
  return [...buckets.values()].sort((left, right) => right.bytes - left.bytes);
}

const RESULT_ITEMS_SHOWN = 8;

/**
 * The screen a person sees right after a clean actually runs (or a --dry-run
 * preview of one). Answers: what got freed, in what, how long it took, and -
 * honestly, grouped by plain-word reason - anything that was left alone or
 * could not be removed. `plan` supplies the candidate behind each result
 * entry so freed/kept/failed rows can use the same `shortLabel` wording as
 * the rest of the CLI instead of a raw candidate id.
 */
export function printResult(result: RunResult, plan: Plan, output: NodeJS.WritableStream): void {
  const colorOn = colorEnabled(output as { isTTY?: boolean });
  const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const resolveLabel = (candidateId: string): string => {
    const candidate = byId.get(candidateId);
    return candidate ? shortLabelForCandidate(candidate) : candidateId;
  };

  output.write("\n");

  if (result.results.length === 0) {
    output.write(`  ${bold("Nothing to clean here.", colorOn)} Nothing in this plan was eligible.\n\n`);
    return;
  }

  const freedEntries = result.results.filter((entry) => entry.status === (result.dryRun ? "would-delete" : "deleted"));
  const freedBytes = result.dryRun ? result.wouldDeleteBytes : result.deletedBytes;
  const duration = durationBetween(result.startedAt, result.finishedAt);
  const verb = result.dryRun ? "Would free" : "Freed";

  if (freedBytes > 0) {
    output.write(`  ${bold(green(`${verb} ${formatBytes(freedBytes)}`, colorOn), colorOn)}${duration ? dim(`, in ${duration}`, colorOn) : ""}\n`);
    const byLabel = bucketByReason(
      freedEntries.map((entry) => ({ bytes: entry.bytes, reason: resolveLabel(entry.candidateId) })),
      (label) => label,
    );
    for (const entry of byLabel.slice(0, RESULT_ITEMS_SHOWN)) {
      output.write(`    ${padRight(formatBytes(entry.bytes), 9)} ${entry.reason}${entry.count > 1 ? ` (x${entry.count})` : ""}\n`);
    }
    const hidden = byLabel.length - RESULT_ITEMS_SHOWN;
    if (hidden > 0) output.write(`    ${dim(`+ ${hidden} more item(s)`, colorOn)}\n`);
  } else {
    output.write(`  ${bold("Nothing removed.", colorOn)}${duration ? dim(` (${duration})`, colorOn) : ""}\n`);
  }

  const quarantinedBytes = result.quarantinedBytes ?? 0;
  if (quarantinedBytes > 0) output.write(`  ${formatBytes(quarantinedBytes)} moved to a safety holding area, not deleted\n`);

  const kept = result.results.filter((entry) => entry.status === "declined" || entry.status === "skipped");
  const keptBytes = (result.declinedBytes ?? 0) + result.skippedBytes;
  if (keptBytes > 0) {
    output.write(`\n  ${yellow(`${formatBytes(keptBytes)} left alone`, colorOn)}\n`);
    for (const entry of bucketByReason(kept, (raw) => primaryReason(raw || "not eligible"))) {
      output.write(`    ${padRight(formatBytes(entry.bytes), 9)} ${entry.reason}${entry.count > 1 ? ` (x${entry.count})` : ""}\n`);
    }
  }

  const failed = result.results.filter((entry) => entry.status === "failed");
  if (failed.length > 0) {
    output.write(`\n  ${red(`${formatBytes(result.failedBytes)} could not be removed`, colorOn)}\n`);
    for (const entry of bucketByReason(failed, (raw) => humanFailure(raw || "unknown error"))) {
      output.write(`    ${padRight(formatBytes(entry.bytes), 9)} ${entry.reason}${entry.count > 1 ? ` (x${entry.count})` : ""}\n`);
    }
  }

  output.write("\n");
}
