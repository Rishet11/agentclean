import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { Candidate, ExecuteContext, StorageProvider, Validation } from "../core/types.js";
import { runCommand } from "../core/command.js";
import { measureTree } from "../core/filesystem.js";
import { hashValue } from "../core/plan.js";
import { normalizeVersion } from "./command.js";
import { isWithin, isWithinAny, safeRealPath, samePath } from "../core/paths.js";
import { canRegisterRoot, dropNested } from "../core/roots.js";

interface WorktreeRecord { path: string; branch?: string; locked: boolean; prunable: boolean; }

/**
 * Small bounded-concurrency gate; caps parallel subprocess spawns. No dependency
 * needed (same pattern as the one in core/filesystem.ts for directory walks).
 */
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export function parseWorktrees(output: string): WorktreeRecord[] {
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
    const limit = createLimiter(12);
    // `git worktree list` runs once per discovered repo root, and a linked
    // worktree's own `.git` file makes findRepositories treat it as a repo
    // root too, so this is often more than one spawn per real repository.
    // Independent of every other repo's listing, so it goes through the same
    // bounded gate as the per-worktree checks below rather than one at a time.
    const listings = await Promise.all(
      repositories.map((repo) => limit(async () => ({ repo, entries: await worktrees(repo).catch(() => undefined) }))),
    );
    const seen = new Set<string>();
    const tasks: Array<() => Promise<Candidate>> = [];
    for (const { repo, entries } of listings) {
      if (!entries) continue;
      const main = entries[0]?.path;
      for (const entry of entries.slice(1)) {
        const target = path.resolve(entry.path);
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        if (seen.has(key)) continue;
        seen.add(key);
        tasks.push(() => this.buildCandidate(repo, entry, target, main, context));
      }
    }
    // Every worktree's checks are independent of every other's; the heavy
    // part -- three subprocess spawns plus a tree measurement per worktree --
    // runs with bounded concurrency so ~40 worktrees don't mean ~120
    // sequential spawns. Every blocker below is still computed for every
    // worktree; nothing here changes what gets checked, only when.
    return await Promise.all(tasks.map((task) => limit(task)));
  }

  private async buildCandidate(
    repo: string,
    entry: WorktreeRecord,
    target: string,
    main: string | undefined,
    context: ExecuteContext,
  ): Promise<Candidate> {
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
    return {
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
    };
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

export interface DerivedWorktreePoolRoot {
  /** Directory to register as an approved root. */
  root: string;
  /** How many of this pool's currently-unregistered worktrees sit under it. */
  worktreeCount: number;
}

/** Deepest directory every path in `paths` shares. Undefined only for an empty input. */
function longestCommonDirectory(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  let common = path.resolve(paths[0]).split(path.sep);
  for (const entry of paths.slice(1)) {
    const segments = path.resolve(entry).split(path.sep);
    let index = 0;
    const max = Math.min(common.length, segments.length);
    while (index < max && common[index] === segments[index]) index += 1;
    common = common.slice(0, index);
  }
  if (common.length === 0) return undefined;
  const joined = common.join(path.sep);
  return joined === "" ? path.sep : joined;
}

/**
 * Finds directories that git's own worktree metadata proves hold spare
 * copies (linked worktrees) outside every currently-approved root, so a
 * caller can register them and stop refusing real, git-verified worktrees on
 * `outside-allowed-root` alone. `~/.ao` (or any other specific path) never
 * appears here -- every directory this returns is read out of `git worktree
 * list --porcelain`, never assumed.
 *
 * Grouping is per repository, never across repositories: a shared parent
 * between two unrelated projects' pools is not evidence of anything, so it
 * is never inferred. Within one repository, this takes the deepest directory
 * shared by the *parents* of that repository's own linked, non-main
 * worktrees that are not already inside `context.roots`. A repository with
 * exactly one such worktree yields that worktree's own parent directory --
 * the pool directory a single instance still implies -- rather than the
 * worktree's own path, which is why every parent (not every worktree path
 * itself) feeds the common-directory computation. Several worktrees under
 * the same pool converge on that shared pool directory directly, instead of
 * each getting its own entry.
 *
 * Every candidate then passes `canRegisterRoot` before being offered -- this
 * function proposes evidence, it never itself decides something is safe to
 * register. Read-only and bounded like `discoverRoots`: a failure here must
 * never fail the surrounding scan, only skip the convenience.
 */
export async function discoverWorktreePoolRoots(context: { roots: string[]; home: string }): Promise<DerivedWorktreePoolRoot[]> {
  try {
    const repositories = await findRepositories(context.roots);
    const limit = createLimiter(12);
    const listings = await Promise.all(repositories.map((repo) => limit(() => worktrees(repo).catch(() => undefined))));
    const outsidePaths: string[] = [];
    const candidateParents = new Set<string>();
    for (const entries of listings) {
      if (!entries || entries.length <= 1) continue;
      const main = entries[0]?.path;
      const outsideForRepo: string[] = [];
      for (const entry of entries.slice(1)) {
        const target = path.resolve(entry.path);
        if (main && samePath(main, target)) continue;
        if (isWithinAny(context.roots, target)) continue;
        outsideForRepo.push(target);
      }
      if (outsideForRepo.length === 0) continue;
      outsidePaths.push(...outsideForRepo);
      const parent = longestCommonDirectory(outsideForRepo.map((item) => path.dirname(item)));
      if (parent) candidateParents.add(parent);
    }
    const safe = dropNested([...candidateParents].filter((candidate) => canRegisterRoot(candidate, context.home, context.roots)));
    return safe
      .map((root) => ({ root, worktreeCount: outsidePaths.filter((item) => isWithin(root, item)).length }))
      .filter((pool) => pool.worktreeCount > 0);
  } catch {
    return [];
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
