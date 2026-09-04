import path from "node:path";
import { lstat } from "node:fs/promises";
import { fingerprintFromStats, type Candidate, type ExecuteContext, type StorageProvider, type Validation } from "../core/types.js";
import { measureTree, removeTree, immediateChildren } from "../core/filesystem.js";
import { isWithin, safeRealPath, samePath } from "../core/paths.js";
import { hashValue } from "../core/plan.js";

export interface DisposableRoot {
  relativePath: string;
  category: "ai-history" | "ai-caches";
  reason: string;
  autoSafe: boolean;
  minAgeDays: number;
}

export class FilesystemProvider implements StorageProvider {
  readonly status = "verified" as const;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly rootResolver: (context: ExecuteContext) => string | undefined,
    private readonly roots: DisposableRoot[],
    private readonly protectedNames: Set<string> = new Set(),
  ) {}

  async detect(context: ExecuteContext) {
    const root = this.rootResolver(context);
    const exists = root ? await safeRealPath(root) : undefined;
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      details: exists ? "documented data root" : "documented data root not present",
      root: exists,
      capabilities: this.roots.map((entry) => `${entry.category}:${entry.relativePath}`),
    };
  }

  async discover(context: ExecuteContext): Promise<Candidate[]> {
    const root = this.rootResolver(context);
    if (!root || !await safeRealPath(root)) return [];
    const candidates: Candidate[] = [];
    for (const rule of this.roots) {
      const targetRoot = path.join(root, rule.relativePath);
      let children: string[];
      try {
        children = await immediateChildren(targetRoot);
      } catch {
        continue;
      }
      for (const target of children) {
        const name = path.basename(target);
        if ([...this.protectedNames].some((protectedName) => protectedName.toLowerCase() === name.toLowerCase())) continue;
        let stats;
        try {
          stats = await lstat(target);
        } catch {
          continue;
        }
        if (stats.isSymbolicLink()) continue;
        const measured = await measureTree(target).catch(() => undefined);
        if (!measured) continue;
        const ageDays = Math.max(0, (context.now - stats.mtimeMs) / 86_400_000);
        const blockers = ageDays < rule.minAgeDays ? [`younger-than-${rule.minAgeDays}-days`] : [];
        candidates.push({
          id: hashValue({ provider: this.id, target, category: rule.category }).slice(0, 16),
          provider: this.id,
          providerStatus: this.status,
          category: rule.category,
          action: "delete",
          target: { kind: "path", path: target },
          reason: `${rule.reason}: ${name}`,
          evidence: [`documented root ${rule.relativePath}`, "direct child of provider-owned directory"],
          bytes: measured.bytes,
          fileCount: measured.fileCount,
          mtimeMs: stats.mtimeMs,
          fingerprint: fingerprintFromStats(stats),
          eligible: blockers.length === 0,
          blockers,
          autoSafe: rule.autoSafe,
          metadata: { root, relativePath: rule.relativePath, minAgeDays: rule.minAgeDays },
        });
      }
    }
    return candidates;
  }

  explain(candidate: Candidate): string {
    return `${candidate.reason}. The path is a direct child of a documented ${this.name} directory and is not a protected entry.`;
  }

  async revalidate(candidate: Candidate, context: ExecuteContext): Promise<Validation> {
    if (candidate.target.kind !== "path") return { ok: false, reason: "path required" };
    const root = this.rootResolver(context);
    const relativePath = candidate.metadata?.relativePath;
    if (!root || typeof relativePath !== "string") return { ok: false, reason: "missing provider metadata" };
    const rule = this.roots.find((entry) => entry.relativePath === relativePath);
    if (!rule) return { ok: false, reason: "unsupported provider path" };
    const targetPath = candidate.target.path;
    const targetRoot = path.join(root, relativePath);
    if (!isWithin(root, targetPath) || samePath(targetPath, targetRoot) || !samePath(path.dirname(targetPath), targetRoot)) return { ok: false, reason: "path outside documented provider child" };
    if (!await safeRealPath(targetPath)) return { ok: false, reason: "path missing" };
    let stats;
    try {
      stats = await lstat(targetPath);
    } catch {
      return { ok: false, reason: "path missing" };
    }
    if (stats.isSymbolicLink()) return { ok: false, reason: "reparse-point" };
    if ([...this.protectedNames].some((name) => name.toLowerCase() === path.basename(targetPath).toLowerCase())) return { ok: false, reason: "protected entry" };
    const currentAgeDays = Math.max(0, (context.now - stats.mtimeMs) / 86_400_000);
    if (currentAgeDays < rule.minAgeDays) return { ok: false, reason: `younger-than-${rule.minAgeDays}-days` };
    if (!candidate.fingerprint || stats.size !== candidate.fingerprint.size || stats.mtimeMs !== candidate.fingerprint.mtimeMs || stats.isDirectory() !== (candidate.fingerprint.kind === "directory")) {
      return { ok: false, reason: "changed-since-scan" };
    }
    const measured = await measureTree(targetPath).catch(() => undefined);
    if (!measured || measured.bytes !== candidate.bytes || measured.fileCount !== candidate.fileCount) return { ok: false, reason: "contents-changed-since-scan" };
    return { ok: true };
  }

  async execute(candidate: Candidate): Promise<{ ok: boolean; bytes: number; reason?: string }> {
    if (candidate.target.kind !== "path") return { ok: false, bytes: 0, reason: "path required" };
    await removeTree(candidate.target.path);
    return { ok: true, bytes: candidate.bytes };
  }
}
