import type { Candidate, ExecuteContext, Plan, StorageProvider } from "./types.js";
import { createPlan, hashValue } from "./plan.js";

export async function scanProviders(providers: StorageProvider[], context: ExecuteContext, filters: { category?: string; provider?: string } = {}): Promise<Plan> {
  const candidates: Candidate[] = [];
  for (const provider of providers) {
    if (filters.provider && provider.id !== filters.provider) continue;
    const discovered = await provider.discover(context);
    for (const candidate of discovered) if (!filters.category || candidate.category === filters.category) candidates.push(candidate);
  }
  candidates.sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id));
  return createPlan(candidates, [...context.roots], context.now, { policyHash: hashValue(context.policy), platform: process.platform, home: context.home, providerIds: providers.map((provider) => provider.id) });
}
