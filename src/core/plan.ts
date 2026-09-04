import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candidate, Plan } from "./types.js";
import { ensureDirectory } from "./filesystem.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export interface PlanMetadata {
  policyHash: string;
  platform: string;
  home: string;
  providerIds: string[];
}

export function createPlan(candidates: Candidate[], roots: string[], now = Date.now(), metadata: PlanMetadata): Plan {
  const normalized = candidates.map((candidate, index) => ({ ...candidate, id: candidate.id || hashValue({ candidate, index }).slice(0, 16) }));
  const body = { schemaVersion: 1 as const, generatedAt: new Date(now).toISOString(), roots, policyHash: metadata.policyHash, platform: metadata.platform, home: metadata.home, providerIds: [...metadata.providerIds].sort(), candidates: normalized };
  return { ...body, hash: hashValue(body) };
}

export function verifyPlan(plan: Plan): boolean {
  const { hash, ...body } = plan;
  return hash === hashValue(body);
}

export async function savePlan(plan: Plan, target: string): Promise<void> {
  await ensureDirectory(path.dirname(target));
  await writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export async function loadPlan(target: string): Promise<Plan> {
  const parsed = JSON.parse(await readFile(target, "utf8")) as Plan;
  if (parsed.schemaVersion !== 1 || !verifyPlan(parsed)) throw new Error("plan hash or schema is invalid");
  return parsed;
}
