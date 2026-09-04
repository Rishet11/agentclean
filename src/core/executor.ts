import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withExecutionLock } from "./locks.js";
import { invalidateMeasureCache } from "./measure-cache.js";
import { hashValue, savePlan, verifyPlan } from "./plan.js";
import { isWithinAny } from "./paths.js";
import { type ExecuteContext, type Plan, type RunResult, type StorageProvider } from "./types.js";

export interface ExecuteOptions {
  dryRun: boolean;
  strict: boolean;
  forceUnlock?: boolean;
}

export async function executePlan(plan: Plan, providers: Map<string, StorageProvider>, context: ExecuteContext, options: ExecuteOptions): Promise<RunResult> {
  if (!verifyPlan(plan)) throw new Error("refusing to execute a plan with an invalid hash");
  const currentProviderIds = [...providers.keys()].sort();
  if (plan.policyHash !== hashValue(context.policy) || plan.platform !== process.platform || plan.home !== context.home || plan.providerIds.join("\0") !== currentProviderIds.join("\0")) throw new Error("refusing to execute a plan from a different policy, platform, home, or provider set");
  if (plan.roots.some((root) => !isWithinAny(context.roots, root))) throw new Error("refusing to execute a plan outside the current roots");
  if (plan.candidates.some((candidate) => candidate.providerStatus !== "verified" && candidate.eligible)) throw new Error("refusing to execute an eligible non-verified provider candidate");
  const execute = async (): Promise<RunResult> => {
    const startedAt = new Date().toISOString();
    const result: RunResult = { schemaVersion: 2, startedAt, finishedAt: startedAt, planHash: plan.hash, dryRun: options.dryRun, results: [], deletedBytes: 0, wouldDeleteBytes: 0, declinedBytes: 0, skippedBytes: 0, failedBytes: 0 };
    const manifestPath = path.join(context.runDir, `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`);
    const persist = async (): Promise<void> => {
      if (!options.dryRun) await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    };
    for (const candidate of plan.candidates) {
      if (candidate.action === "skip" || !candidate.eligible || candidate.blockers.length > 0) {
        result.results.push({ candidateId: candidate.id, status: "declined", bytes: candidate.bytes, reason: candidate.blockers.join(", ") || "not eligible" });
        result.declinedBytes = (result.declinedBytes || 0) + candidate.bytes;
        await persist();
        continue;
      }
      const provider = providers.get(candidate.provider);
      if (!provider) {
        result.results.push({ candidateId: candidate.id, status: "skipped", bytes: candidate.bytes, reason: "provider unavailable" });
        result.skippedBytes += candidate.bytes;
        await persist();
        continue;
      }
      const validation = await provider.revalidate(candidate, context);
      if (!validation.ok) {
        result.results.push({ candidateId: candidate.id, status: "skipped", bytes: candidate.bytes, reason: validation.reason || "changed since scan" });
        result.skippedBytes += candidate.bytes;
        await persist();
        continue;
      }
      if (options.dryRun) {
        result.results.push({ candidateId: candidate.id, status: "would-delete", bytes: candidate.bytes });
        result.wouldDeleteBytes += candidate.bytes;
        continue;
      }
      try {
        const action = await provider.execute(candidate, context);
        if (!action.ok) {
          result.results.push({ candidateId: candidate.id, status: "failed", bytes: candidate.bytes, reason: action.reason || "provider action failed" });
          result.failedBytes += candidate.bytes;
        } else {
          result.results.push({ candidateId: candidate.id, status: "deleted", bytes: action.bytes });
          result.deletedBytes += action.bytes;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "cleanup failed";
        result.results.push({ candidateId: candidate.id, status: "failed", bytes: candidate.bytes, reason });
        result.failedBytes += candidate.bytes;
      }
      await persist();
    }
    result.finishedAt = new Date().toISOString();
    if (options.strict && ((result.declinedBytes || 0) > 0 || result.skippedBytes > 0 || result.failedBytes > 0)) result.strictViolation = true;
    await persist();
    // A prune can empty a cache without touching the root directory's mtime, so
    // a cached measurement would keep advertising space that is already gone.
    // Measured: after uv cache prune took ~/.cache/uv from 10.06 GB to 1.9 GB,
    // the next scan still offered 10.06 GB from cache.
    if (!options.dryRun && (result.deletedBytes > 0 || (result.quarantinedBytes ?? 0) > 0)) {
      await invalidateMeasureCache(context.runDir);
    }
    return result;
  };
  return options.dryRun ? execute() : withExecutionLock(context.runDir, execute, { forceUnlock: options.forceUnlock });
}

export async function persistPlan(plan: Plan, target: string): Promise<void> {
  await savePlan(plan, target);
}
