import type { Stats } from "node:fs";

export type Category = "worktrees" | "ai-history" | "ai-caches" | "package-caches" | "project-dependencies" | "project-environments" | "build-artifacts";
export type ProviderStatus = "verified" | "diagnostic" | "unavailable";
export type CandidateAction = "delete" | "provider-command" | "skip";

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
  metadata?: Record<string, string | number | boolean>;
}

export interface ProviderDetection {
  id: string;
  name: string;
  status: ProviderStatus;
  details: string;
  root?: string;
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
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  planHash: string;
  dryRun: boolean;
  results: Array<{
    candidateId: string;
    status: "deleted" | "would-delete" | "skipped" | "failed";
    bytes: number;
    reason?: string;
  }>;
  deletedBytes: number;
  wouldDeleteBytes: number;
  skippedBytes: number;
  failedBytes: number;
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
