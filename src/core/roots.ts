import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isWithin, safeRealPath, samePath } from "./paths.js";

const commonDevDirectories = ["Desktop", "Documents", "src", "dev", "code", "projects", "work", "repos", "git", "Developer"];
const maxGitSearchDepth = 2;
const maxDirectoriesVisited = 5_000;

async function isRealDirectory(target: string): Promise<boolean> {
  const stats = await lstat(target).catch(() => undefined);
  return !!stats && stats.isDirectory() && !stats.isSymbolicLink();
}

async function hasGit(target: string): Promise<boolean> {
  return await lstat(path.join(target, ".git")).then(() => true).catch(() => false);
}

async function findGitRepoDirs(root: string, budget: { count: number }): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (budget.count >= maxDirectoriesVisited) return;
    budget.count += 1;
    if (await hasGit(current)) {
      found.push(current);
      return;
    }
    if (depth >= maxGitSearchDepth) return;
    const entries = await readdir(current).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const child = path.join(current, entry);
      if (!(await isRealDirectory(child))) continue;
      await visit(child, depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

// Exported so ../providers/git.ts can collapse a second, independently-derived
// evidence source (git worktree pool roots) with the same "shallowest wins"
// rule used here, instead of re-implementing it.
export function dropNested(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((left, right) => left.length - right.length);
  const kept: string[] = [];
  for (const candidate of unique) {
    if (kept.some((existing) => isWithin(existing, candidate))) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * How many path segments `candidate` sits below its own filesystem root (`/`
 * on POSIX, a drive root like `C:\` on Windows). `/etc`, `/Users`, and
 * `C:\Windows` all sit at exactly one segment; a real per-project worktree
 * pool is never that shallow. This is a structural stand-in for an
 * enumerated system-directory list: it rejects the *shape* of "top-level OS
 * directory" without having to name every OS's set of them, and stays
 * correct on ones this file has never heard of.
 */
function segmentsBelowFilesystemRoot(candidate: string): number {
  const resolved = path.resolve(candidate);
  const { root } = path.parse(resolved);
  const relative = path.relative(root, resolved);
  return relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
}

/**
 * Refuses to let `candidate` be registered as an approved scan root when
 * doing so would approve far more than the evidence justifies. Three
 * independent failure shapes, each checked directly (see roots.test.ts):
 *
 *  - `candidate` is the user's home directory, or an ancestor of it (up to
 *    and including the filesystem root). Registering either exposes every
 *    unrelated file the user has, not just a worktree pool.
 *  - `candidate` is a top-level OS directory (fewer than two path segments
 *    below a filesystem/drive root: `/etc`, `/Users`, `C:\Windows`, ...).
 *    A real worktree pool is always at least a couple of levels deeper than
 *    that, so anything this shallow means the derivation went wrong, not
 *    that the directory is legitimately a pool.
 *  - `candidate` would swallow a root the caller already approved for an
 *    unrelated reason (`existingRoots`): registering it would silently
 *    re-justify that root under "git worktree evidence" instead of whatever
 *    it was actually approved for, and approve everything else beside it.
 *
 * Pure and synchronous on purpose -- no filesystem access -- so every case
 * above is directly testable with plain strings, no fixtures required.
 */
export function canRegisterRoot(candidate: string, home: string, existingRoots: string[]): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedHome = path.resolve(home);
  if (isWithin(resolvedCandidate, resolvedHome)) return false;
  if (segmentsBelowFilesystemRoot(resolvedCandidate) < 2) return false;
  if (existingRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return !samePath(resolvedRoot, resolvedCandidate) && isWithin(resolvedCandidate, resolvedRoot);
  })) return false;
  return true;
}

/**
 * Zero-config root discovery: common development directory names directly under
 * `home` plus any directory that contains a git repository at shallow depth from
 * those. Read-only, bounded, and never throws — a discovery failure just means an
 * empty result, never a crash of the surrounding scan.
 */
export async function discoverRoots(context: { home: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<string[]> {
  try {
    const found = new Set<string>();
    const budget = { count: 0 };
    for (const name of commonDevDirectories) {
      if (budget.count >= maxDirectoriesVisited) break;
      const candidate = path.join(context.home, name);
      if (!(await isRealDirectory(candidate))) continue;
      const resolved = await safeRealPath(candidate);
      if (!resolved) continue;
      found.add(resolved);
      for (const repoDir of await findGitRepoDirs(resolved, budget)) {
        const repoResolved = await safeRealPath(repoDir);
        if (repoResolved) found.add(repoResolved);
      }
    }
    return dropNested([...found]);
  } catch {
    return [];
  }
}
