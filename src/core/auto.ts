import type { Candidate, Plan, Policy } from "./types.js";
import { policyAllowsAuto } from "./policy.js";
import { createPlan } from "./plan.js";

export function autoPlan(plan: Plan, policy: Policy, now = Date.now()): Plan {
  const candidates = plan.candidates.filter((candidate: Candidate) => policyAllowsAuto(candidate, policy, now));
  return createPlan(candidates, plan.roots, now, { policyHash: plan.policyHash, platform: plan.platform, home: plan.home, providerIds: plan.providerIds });
}
