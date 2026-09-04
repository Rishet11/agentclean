import type { Stats } from "node:fs";

export type Category = "worktrees" | "ai-history" | "ai-caches" | "package-caches" | "project-dependencies" | "project-environments" | "build-artifacts";
export type ProviderStatus = "verified" | "diagnostic" | "unavailable";
export type CandidateAction = "delete" | "provider-command" | "skip";
export type RestoreTier = "free" | "cheap" | "irreplaceable";

/**
 * What it costs to get a candidate back.
 *
 * Size answers "what is big". It does not answer the question the human is
 * actually asking, which is "what can I lose without regretting it". A 200 MB
 * .next that rebuilds offline in 12s is a better deletion than a 400 MB
 * virtualenv that needs the network and four minutes, and a virtualenv with no
 * requirements file is not recoverable at all. Providers populate this and the
 * report sorts and groups by it.
 */
export interface RestoreCost {
  tier: RestoreTier;
  /** Estimated seconds to restore, or "unknown" when we genuinely cannot say. */
  seconds: number | "unknown";
  /** The literal command, e.g. "npm ci". Empty string when there is no way back. */
  method: string;
  needsNetwork: boolean;
  confidence: "measured" | "estimated" | "unknown";
}

export interface Fingerprint {
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
}

export type CandidateTarget =
  | { kind: "path"; path: string }
  | { kind: "command"; command: string[]; cwd?: string };

export interface Candidate {
  id: string;
  provider: string;
  providerStatus: ProviderStatus;
  category: Category;
  action: CandidateAction;
  target: CandidateTarget;
  reason: string;
  evidence: string[];
  bytes: number;
  fileCount: number;
  mtimeMs: number;
  fingerprint?: Fingerprint;
  eligible: boolean;
  blockers: string[];
  autoSafe: boolean;
  restoreCost?: RestoreCost;
  /** True when measurement hit a bound and `bytes` is a lower bound, not a total. */
  partialMeasurement?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface ProviderDetection {
  id: string;
  name: string;
  status: ProviderStatus;
  details: string;
  root?: string;
  /**
   * Provider or rule-set version behind the decision. A saved plan must not
   * outlive a provider upgrade that changed what a directory means.
   */
  version?: string;
  capabilities: string[];
}

export interface ScanContext {
  now: number;
  roots: string[];
  configRoots: string[];
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  policy: Policy;
  allowProjectArtifacts?: boolean;
}

export interface ExecuteContext extends ScanContext {
  dryRun: boolean;
  runDir: string;
}

export interface Validation {
  ok: boolean;
  reason?: string;
}

export interface ActionResult {
  ok: boolean;
  bytes: number;
  reason?: string;
}

export interface StorageProvider {
  readonly id: string;
  readonly name: string;
  readonly status: ProviderStatus;
  detect(context: ScanContext): Promise<ProviderDetection>;
  discover(context: ScanContext): Promise<Candidate[]>;
  explain(candidate: Candidate): string;
  revalidate(candidate: Candidate, context: ExecuteContext): Promise<Validation>;
  execute(candidate: Candidate, context: ExecuteContext): Promise<ActionResult>;
}

export interface Policy {
  version: 1;
  safeCacheAgeDays: number;
  historyAgeDays: number;
  worktreeInactiveDays: number;
  autoCategories: Category[];
  autoProviders: string[];
  worktreeRoots: string[];
}

export interface ConfigFile {
  version: 1;
  roots: string[];
  policy: Policy;
  allowProjectArtifacts?: boolean;
}

export interface Plan {
  schemaVersion: 1;
  generatedAt: string;
  roots: string[];
  policyHash: string;
  platform: string;
  home: string;
  providerIds: string[];
  candidates: Candidate[];
  hash: string;
}

export interface RunResult {
  schemaVersion: 1 | 2;
  runId?: string;
  startedAt: string;
  finishedAt: string;
  planHash: string;
  dryRun: boolean;
  results: Array<{
    candidateId: string;
    status: "deleted" | "would-delete" | "declined" | "skipped" | "failed" | "quarantined" | "already-done";
    bytes: number;
    reason?: string;
    restoreCommand?: string;
    quarantinePath?: string;
  }>;
  deletedBytes: number;
  wouldDeleteBytes: number;
  /** Ineligible by design, e.g. younger-than-30-days. Never a failure. */
  declinedBytes?: number;
  /** Real deviations only: provider unavailable, or revalidation rejected it. */
  skippedBytes: number;
  failedBytes: number;
  /** Moved to the holding area. Never counted as reclaimed. */
  quarantinedBytes?: number;
  purgeAfter?: string;
  resumedFrom?: string;
  strictViolation?: boolean;
}

export function fingerprintFromStats(stats: Stats): Fingerprint {
  return {
    kind: stats.isDirectory() ? "directory" : "file",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
  };
}
