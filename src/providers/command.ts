import path from "node:path";
import type { Candidate, ExecuteContext, ProviderDetection, StorageProvider, Validation } from "../core/types.js";
import { runCommand } from "../core/command.js";
import { measureTree } from "../core/filesystem.js";
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
    const measured = await measureTree(resolved).catch(() => undefined);
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
