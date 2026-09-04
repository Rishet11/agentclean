import { lstat } from "node:fs/promises";
import path from "node:path";
import type { Candidate, ExecuteContext, ProviderDetection, StorageProvider, Validation } from "../core/types.js";
import { fingerprintFromStats } from "../core/types.js";
import { runCommand } from "../core/command.js";
import { approximateTree, getSharedMeasureCache, measureCacheKey, measureTree, peekMeasureCache, type TreeStats } from "../core/filesystem.js";
import { hashValue } from "../core/plan.js";
import { safeRealPath, samePath } from "../core/paths.js";

/**
 * Picks the cache path out of a tool's stdout. The naive "last line" reading
 * accepts a trailing warning line as the path, which then becomes a delete
 * target, so prefer the last line that actually looks absolute.
 */
export function parseCachePath(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (path.isAbsolute(line) || /^[a-zA-Z]:[\\/]/.test(line)) return line;
  }
  return lines.pop();
}

/** First semver-ish token in a tool's version output, for plan invalidation. */
export function normalizeVersion(output: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(output)?.[0];
}

export interface CommandProviderOptions {
  /**
   * How to ask the tool its version. Defaults to `<tool> --version`, but not
   * every CLI has that flag: `go --version` fails with "flag provided but not
   * defined" while `go version` works, which made the go provider report
   * itself unavailable on a machine where it was installed.
   */
  versionCommand?: string[];
}

export class CommandProvider implements StorageProvider {
  readonly status = "verified" as const;

  constructor(readonly id: string, readonly name: string, private readonly pathCommand: string[], private readonly cleanupCommand: string[], private readonly reason: string, private readonly autoSafe: boolean, private readonly options: CommandProviderOptions = {}) {}

  async detect(): Promise<ProviderDetection> {
    try {
      const version = await runCommand(this.options.versionCommand ?? [this.pathCommand[0], "--version"], undefined, 5_000);
      if (version.code !== 0) return { id: this.id, name: this.name, status: "unavailable", details: "command unavailable", capabilities: [] };
      return { id: this.id, name: this.name, status: this.status, details: "provider command available", version: normalizeVersion(`${version.stdout}${version.stderr}`), capabilities: ["provider-command"] };
    } catch {
      return { id: this.id, name: this.name, status: "unavailable", details: "command unavailable", capabilities: [] };
    }
  }

  /**
   * Cleanup is delegated to the provider's own command (`uv cache prune`, and
   * so on) so an exact byte count is not required to act on a candidate, only
   * to rank and report it. A full `measureTree` of these directories is
   * expensive purely for that: `~/.cache/uv` alone is ~122k files and costs
   * 20-30s on a cold page cache. So:
   *
   *  1. Prefer an exact figure already sitting in the shared measurement
   *     cache (near-free: one lstat + one map lookup + one readdir).
   *  2. Otherwise, try a budgeted `approximateTree` (~1.5s). If it finishes
   *     without hitting its bound, that number IS exact (same walk, just
   *     bounded) — use and cache it, so the next run is a cache hit too.
   *  3. Only if the budgeted walk is genuinely incomplete do we pay for a
   *     real `measureTree`. An incomplete approximation is not close enough
   *     to trust for ranking: measured on this machine, a 1.5s budget on
   *     `~/.cache/uv` (true size ~10.06 GB) returned ~2.26 GB, over 4x low —
   *     enough to misrank the single largest cache below git/npm in the
   *     plain-text report, which has no way to mark a number as partial.
   *     Reporting that silently would be a correctness regression, not a
   *     speed win, so we refuse to ship it and pay the real cost instead.
   *     This full walk still populates the cache, so only the first run
   *     after a cold/invalidated cache entry pays it.
   */
  private async measureCacheDirectory(resolved: string): Promise<TreeStats | undefined> {
    const stats = await lstat(resolved).catch(() => undefined);
    if (!stats || stats.isSymbolicLink()) return undefined;
    if (!stats.isDirectory()) return { bytes: stats.size, fileCount: 1, symlinkCount: 0, partial: false, fingerprint: fingerprintFromStats(stats) };
    const cache = getSharedMeasureCache();
    const key = measureCacheKey(stats);
    const cached = await peekMeasureCache(resolved, cache);
    if (cached) return cached;
    const approximate = await approximateTree(resolved, { budgetMs: 1_500 }).catch(() => undefined);
    if (approximate?.complete) {
      const exact: TreeStats = {
        bytes: approximate.bytes,
        fileCount: approximate.fileCount,
        symlinkCount: approximate.symlinkCount,
        partial: false,
        fingerprint: fingerprintFromStats(stats),
        childCount: approximate.childCount,
      };
      cache?.set(key, exact);
      return exact;
    }
    return await measureTree(resolved).catch(() => undefined);
  }

  async discover(): Promise<Candidate[]> {
    let result;
    try {
      result = await runCommand(this.pathCommand, undefined, 10_000);
    } catch {
      return [];
    }
    if (result.code !== 0) return [];
    const targetPath = parseCachePath(result.stdout);
    if (!targetPath) return [];
    const resolved = path.resolve(targetPath);
    const measured = await this.measureCacheDirectory(resolved);
    if (!measured) return [];
    return [{
      id: hashValue({ provider: this.id, path: resolved }).slice(0, 16),
      provider: this.id,
      providerStatus: this.status,
      category: "package-caches",
      action: "provider-command",
      target: { kind: "command", command: this.cleanupCommand },
      reason: this.reason,
      evidence: [`${this.pathCommand.join(" ")} reported the cache/store path`, "cleanup delegated to provider command"],
      bytes: measured.bytes,
      fileCount: measured.fileCount,
      mtimeMs: measured.fingerprint.mtimeMs,
      fingerprint: measured.fingerprint,
      eligible: true,
      blockers: [],
      autoSafe: this.autoSafe,
      partialMeasurement: measured.partial,
      metadata: { path: resolved },
    }];
  }

  explain(candidate: Candidate): string { return `${candidate.reason}. The provider owns the cleanup command, so opaque cache internals are not deleted directly.`; }

  async revalidate(candidate: Candidate): Promise<Validation> {
    if (candidate.target.kind !== "command" || !candidate.metadata?.path || typeof candidate.metadata.path !== "string") return { ok: false, reason: "invalid provider candidate" };
    const resolved = await safeRealPath(candidate.metadata.path);
    if (!resolved || !samePath(resolved, candidate.metadata.path)) return { ok: false, reason: "cache path unavailable" };
    const current = await runCommand(this.pathCommand, undefined, 10_000).catch(() => undefined);
    const currentPath = current ? parseCachePath(current.stdout) : undefined;
    if (!current || current.code !== 0 || !currentPath || !samePath(currentPath, candidate.metadata.path)) return { ok: false, reason: "provider path changed" };
    return { ok: true };
  }

  async execute(candidate: Candidate) {
    if (candidate.target.kind !== "command") return { ok: false, bytes: 0, reason: "command required" };
    const result = await runCommand(this.cleanupCommand, undefined, 120_000);
    return result.code === 0 ? { ok: true, bytes: candidate.bytes } : { ok: false, bytes: 0, reason: `provider command exited ${result.code}` };
  }
}

export function npmProvider(): CommandProvider { return new CommandProvider("npm", "npm", ["npm", "config", "get", "cache"], ["npm", "cache", "clean", "--force"], "npm package cache", false); }
export function pnpmProvider(): CommandProvider { return new CommandProvider("pnpm", "pnpm", ["pnpm", "store", "path"], ["pnpm", "store", "prune"], "pnpm unreferenced package store", true); }
