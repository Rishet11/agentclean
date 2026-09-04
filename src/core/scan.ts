import type { Candidate, ExecuteContext, Plan, StorageProvider } from "./types.js";
import { createPlan, hashValue } from "./plan.js";
import { restoreCostFor } from "./tiers.js";

export async function scanProviders(
  providers: StorageProvider[],
  context: ExecuteContext,
  filters: { category?: string; provider?: string } = {},
  onProgress?: (done: number, total: number, providerId: string) => void,
): Promise<Plan> {
  const active = providers.filter((provider) => !filters.provider || provider.id === filters.provider);
  let done = 0;
  const settled = await Promise.allSettled(active.map(async (provider) => {
    try {
      return await provider.discover(context);
    } finally {
      done += 1;
      onProgress?.(done, active.length, provider.id);
    }
  }));
  const candidates: Candidate[] = [];
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
  candidates.sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id));
  return createPlan(candidates, [...context.roots], context.now, { policyHash: hashValue(context.policy), platform: process.platform, home: context.home, providerIds: providers.map((provider) => provider.id) });
}
