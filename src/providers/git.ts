import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { Candidate, ExecuteContext, StorageProvider, Validation } from "../core/types.js";
import { runCommand } from "../core/command.js";
import { measureTree } from "../core/filesystem.js";
import { hashValue } from "../core/plan.js";
import { normalizeVersion } from "./command.js";
import { isWithin, isWithinAny, safeRealPath, samePath } from "../core/paths.js";

interface WorktreeRecord { path: string; branch?: string; locked: boolean; prunable: boolean; }

function parseWorktrees(output: string): WorktreeRecord[] {
  const entries: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const token of output.split("\0")) {
    if (!token) {
      if (current?.path) entries.push(current);
      current = undefined;
      continue;
    }
    if (token.startsWith("worktree ")) {
      if (current?.path) entries.push(current);
      current = { path: token.slice(9), locked: false, prunable: false };
    } else if (current && token.startsWith("branch ")) current.branch = token.slice(7);
    else if (current && (token === "locked" || token.startsWith("locked "))) current.locked = true;
    else if (current && (token === "prunable" || token.startsWith("prunable "))) current.prunable = true;
  }
  if (current?.path) entries.push(current);
  return entries;
}

async function worktrees(repo: string): Promise<WorktreeRecord[]> {
  const result = await runCommand(["git", "worktree", "list", "--porcelain", "-z"], repo, 20_000);
  if (result.code !== 0) throw new Error(result.stderr || "git worktree list failed");
  return parseWorktrees(result.stdout);
}

async function status(repo: string): Promise<string> {
  const result = await runCommand(["git", "status", "--porcelain=v2", "--untracked-files=all", "--"], repo, 20_000);
  return result.code === 0 ? result.stdout : "status-unavailable";
}

export class GitWorktreeProvider implements StorageProvider {
  readonly id = "git";
  readonly name = "Git worktrees";
  readonly status = "verified" as const;

  async detect(): Promise<import("../core/types.js").ProviderDetection> {
    const result = await runCommand(["git", "--version"], undefined, 5_000).catch(() => undefined);
    const version = result?.code === 0 ? normalizeVersion(result.stdout) : undefined;
    return { id: this.id, name: this.name, status: result?.code === 0 ? this.status : "unavailable", details: result?.code === 0 ? "Git worktree metadata available" : "Git unavailable", version, capabilities: ["clean-linked-worktrees", "porcelain-status"] };
  }

  async discover(context: ExecuteContext): Promise<Candidate[]> {
    const repositories = await findRepositories(context.roots);
    const output: Candidate[] = [];
    const seen = new Set<string>();
    for (const repo of repositories) {
      let entries;
      try { entries = await worktrees(repo); } catch { continue; }
      const main = entries[0]?.path;
      for (const entry of entries.slice(1)) {
        const target = path.resolve(entry.path);
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        if (seen.has(key)) continue;
        seen.add(key);
        const blockers: string[] = [];
        if (entry.locked) blockers.push("locked");
        if (entry.prunable) blockers.push("missing-or-prunable");
        if (main && samePath(main, target)) blockers.push("main-worktree");
        if (isWithin(target, context.cwd)) blockers.push("current-directory");
        if (!isWithinAny(context.roots, target)) blockers.push("outside-allowed-root");
        const exists = await safeRealPath(target);
        if (!exists) blockers.push("path-missing");
        let measured;
        if (exists) measured = await measureTree(target).catch(() => undefined);
        if (exists && !measured) blockers.push("unmeasurable");
        const worktreeStatus = exists ? await status(target) : "";
        if (worktreeStatus.trim()) blockers.push("dirty-or-untracked");
        const submodules = exists ? await runCommand(["git", "submodule", "status"], target, 20_000).catch(() => undefined) : undefined;
        // git submodule status markers: " " clean, "+" checked-out commit differs
        // from the index, "U" merge conflict, "-" not initialized. Only + and U
        // mean there is state in the worktree to lose. "-" means the submodule
        // was never checked out, so the directory is empty and blocking on it
        // refused 30 of 40 real worktrees while protecting nothing.
        const submoduleLines = submodules?.code === 0 ? submodules.stdout.split(/\r?\n/).filter((line) => line.length > 0) : [];
        const dirtySubmodules = submoduleLines.filter((line) => line.startsWith("+") || line.startsWith("U")).length;
        const uninitializedSubmodules = submoduleLines.filter((line) => line.startsWith("-")).length;
        if (dirtySubmodules > 0) blockers.push("dirty-submodules");
        const ahead = exists ? await runCommand(["git", "rev-list", "--count", "@{upstream}..HEAD"], target, 20_000).catch(() => undefined) : undefined;
        const hasUpstream = ahead?.code === 0;
        const unpushedCommits = hasUpstream ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : undefined;
        const stats = exists ? await lstat(target).catch(() => undefined) : undefined;
        const bytes = measured?.bytes ?? 0;
        output.push({
          id: hashValue({ provider: this.id, repo, target }).slice(0, 16),
          provider: this.id,
          providerStatus: this.status,
          category: "worktrees",
          action: "provider-command",
          target: { kind: "command", command: ["git", "worktree", "remove", target], cwd: repo },
          reason: `Linked worktree for ${path.basename(repo)}`,
          evidence: ["git worktree list --porcelain identified this linked worktree", "git status checked before planning"],
          bytes,
          fileCount: measured?.fileCount ?? 0,
          mtimeMs: stats?.mtimeMs ?? 0,
          fingerprint: stats ? { kind: stats.isDirectory() ? "directory" : "file", size: stats.size, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino } : undefined,
          eligible: blockers.length === 0,
          blockers,
          autoSafe: false,
          partialMeasurement: measured?.partial,
          metadata: {
            repo,
            branch: entry.branch || "detached",
            worktreePath: target,
            hasUpstream,
            ...(unpushedCommits === undefined ? {} : { unpushedCommits }),
            dirtySubmodules,
            uninitializedSubmodules,
          },
        });
      }
    }
    return output;
  }

  explain(candidate: Candidate): string { return `${candidate.reason}. Git metadata and porcelain status are checked again before removal; dirty, locked, missing, current, and submodule worktrees are skipped.`; }

  async revalidate(candidate: Candidate, context: ExecuteContext): Promise<Validation> {
    if (candidate.target.kind !== "command" || !candidate.metadata?.repo || !candidate.metadata.worktreePath) return { ok: false, reason: "invalid worktree candidate" };
    const repo = String(candidate.metadata.repo);
    const target = String(candidate.metadata.worktreePath);
    if (!isWithinAny(context.roots, repo) || !isWithinAny(context.roots, target)) return { ok: false, reason: "outside-allowed-root" };
    const entries = await worktrees(repo).catch(() => []);
    const entry = entries.find((item) => samePath(item.path, target));
    if (!entry) return { ok: false, reason: "worktree no longer registered" };
    const main = entries[0]?.path;
    if (main && samePath(main, target)) return { ok: false, reason: "main-worktree" };
    if (entry.locked) return { ok: false, reason: "locked" };
    if (entry.prunable) return { ok: false, reason: "missing-or-prunable" };
    const currentStatus = await status(target);
    if (currentStatus.trim()) return { ok: false, reason: "dirty-or-untracked" };
    if (isWithin(target, process.cwd())) return { ok: false, reason: "current-directory" };
    const currentStats = await lstat(target).catch(() => undefined);
    if (!currentStats || !candidate.fingerprint || currentStats.mtimeMs !== candidate.fingerprint.mtimeMs || currentStats.size !== candidate.fingerprint.size) return { ok: false, reason: "changed-since-scan" };
    const measured = await measureTree(target).catch(() => undefined);
    if (!measured) return { ok: false, reason: "contents-changed-since-scan" };
    if (measured.partial) return { ok: false, reason: "partial-measurement" };
    if (measured.bytes !== candidate.bytes || measured.fileCount !== candidate.fileCount) return { ok: false, reason: "contents-changed-since-scan" };
    return { ok: true };
  }

  async execute(candidate: Candidate): Promise<{ ok: boolean; bytes: number; reason?: string }> {
    const repo = candidate.metadata?.repo;
    const target = candidate.metadata?.worktreePath;
    if (typeof repo !== "string" || typeof target !== "string") return { ok: false, bytes: 0, reason: "invalid worktree metadata" };
    const result = await runCommand(["git", "worktree", "remove", target], repo, 120_000);
    return result.code === 0 ? { ok: true, bytes: candidate.bytes } : { ok: false, bytes: 0, reason: result.stderr.trim() || `git exited ${result.code}` };
  }
}

async function findRepositories(roots: string[]): Promise<string[]> {
  const found = new Set<string>();
  const visited = new Set<string>();
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 8 || visited.has(current)) return;
    visited.add(current);
    const info = await lstat(current).catch(() => undefined);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
    const resolved = await safeRealPath(current);
    if (!resolved || !samePath(resolved, current)) return;
    const gitEntry = await lstat(path.join(current, ".git")).catch(() => undefined);
    if (gitEntry) {
      found.add(current);
      return;
    }
    const entries = await readdir(current).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules" || entry === "vendor" || entry === ".cache") continue;
      await visit(path.join(current, entry), depth + 1);
    }
  };
  for (const root of roots) await visit(path.resolve(root), 0);
  return [...found];
}
