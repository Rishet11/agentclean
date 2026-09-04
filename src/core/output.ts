import type { Candidate, Plan, ProviderDetection, RunResult } from "./types.js";
import { categoryLabel } from "./policy.js";
import { displayPath } from "./paths.js";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function printPlan(plan: Plan, output: NodeJS.WritableStream): void {
  output.write(`Found ${plan.candidates.length} candidate(s). Plan ${plan.hash.slice(0, 12)}.\n`);
  for (const candidate of plan.candidates) {
    const target = candidate.target.kind === "path" ? displayPath(candidate.target.path) : candidate.target.command.join(" ");
    const state = candidate.eligible && candidate.blockers.length === 0 ? candidate.action : `skip: ${candidate.blockers.join(", ") || "not eligible"}`;
    output.write(`- [${categoryLabel(candidate.category)}] ${candidate.provider}: ${target}\n`);
    output.write(`  ${formatBytes(candidate.bytes)}, ${candidate.fileCount} file(s), ${state}\n`);
    output.write(`  ${candidate.reason}\n`);
  }
}

export function printProviders(detections: ProviderDetection[], output: NodeJS.WritableStream): void {
  for (const detection of detections) output.write(`${detection.id}\t${detection.status}\t${detection.details}${detection.root ? `\t${displayPath(detection.root)}` : ""}\n`);
}

export function printResult(result: RunResult, output: NodeJS.WritableStream): void {
  output.write(`Deleted: ${formatBytes(result.deletedBytes)}\nWould delete: ${formatBytes(result.wouldDeleteBytes)}\nSkipped: ${formatBytes(result.skippedBytes)}\nFailed: ${formatBytes(result.failedBytes)}\n`);
  for (const entry of result.results) if (entry.status === "skipped" || entry.status === "failed") output.write(`- ${entry.candidateId}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}\n`);
}
