import type { Candidate, Category, Policy } from "./types.js";

export const defaultPolicy: Policy = {
  version: 1,
  safeCacheAgeDays: 30,
  historyAgeDays: 90,
  worktreeInactiveDays: 30,
  autoCategories: ["ai-caches", "package-caches"],
  autoProviders: ["claude", "opencode", "pnpm"],
  worktreeRoots: [],
};

export function ageDays(now: number, mtimeMs: number): number {
  return Math.max(0, (now - mtimeMs) / 86_400_000);
}

export function policyAllowsAuto(candidate: Candidate, policy: Policy, now: number): boolean {
  if (!candidate.autoSafe) return false;
  if (!policy.autoCategories.includes(candidate.category)) return false;
  if (!policy.autoProviders.includes(candidate.provider)) return false;
  if (candidate.category === "ai-history" && ageDays(now, candidate.mtimeMs) < policy.historyAgeDays) return false;
  if (candidate.category !== "ai-history" && ageDays(now, candidate.mtimeMs) < policy.safeCacheAgeDays) return false;
  if (candidate.providerStatus !== "verified") return false;
  if (candidate.action !== "delete" && candidate.action !== "provider-command") return false;
  if (candidate.category === "project-dependencies" || candidate.category === "project-environments" || candidate.category === "build-artifacts") return false;
  return candidate.eligible && candidate.blockers.length === 0;
}

export function categoryLabel(category: Category): string {
  if (category === "ai-history") return "AI history";
  if (category === "ai-caches") return "AI caches";
  if (category === "package-caches") return "package caches";
  if (category === "project-dependencies") return "project dependencies";
  if (category === "project-environments") return "Python environments";
  if (category === "build-artifacts") return "build artifacts";
  return "Git worktrees";
}
