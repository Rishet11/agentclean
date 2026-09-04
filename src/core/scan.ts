import type { Candidate, ExecuteContext, Plan, StorageProvider } from "./types.js";
import { createPlan, hashValue } from "./plan.js";
import { restoreCostFor } from "./tiers.js";
import { setSharedMeasureCache } from "./filesystem.js";
import { loadMeasureCache } from "./measure-cache.js";

export async function scanProviders(
  providers: StorageProvider[],
  context: ExecuteContext,
  filters: { category?: string; provider?: string } = {},
  onProgress?: (done: number, total: number, providerId: string) => void,
): Promise<Plan> {
  const active = providers.filter((provider) => !filters.provider || provider.id === filters.provider);
  // Loaded and set as the shared cache only for the extent of discover() below,
  // then cleared before this function returns: revalidate() (run later, right
  // before a delete) must always see no cache and always re-measure fresh.
  const persistedCache = await loadMeasureCache(context.runDir);
  setSharedMeasureCache(persistedCache.cache);
  let candidates: Candidate[];
  try {
    let done = 0;
    const settled = await Promise.allSettled(active.map(async (provider) => {
      try {
        return await provider.discover(context);
      } finally {
        done += 1;
        onProgress?.(done, active.length, provider.id);
      }
    }));
    candidates = [];
    settled.forEach((result, index) => {
      const provider = active[index];
      if (result.status === "rejected") {
        process.stderr.write(`provider "${provider.id}" failed during discovery: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
        return;
      }
      for (const candidate of result.value) {
        if (filters.category && candidate.category !== filters.category) continue;
        candidates.push({ ...candidate, restoreCost: restoreCostFor(candidate) });
      }
    });
  } finally {
    setSharedMeasureCache(undefined);
    await persistedCache.save();
  }
  candidates.sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id));
  return createPlan(candidates, [...context.roots], context.now, { policyHash: hashValue(context.policy), platform: process.platform, home: context.home, providerIds: providers.map((provider) => provider.id) });
}
