import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isWithin, safeRealPath } from "./paths.js";

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

function dropNested(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((left, right) => left.length - right.length);
  const kept: string[] = [];
  for (const candidate of unique) {
    if (kept.some((existing) => isWithin(existing, candidate))) continue;
    kept.push(candidate);
  }
  return kept;
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
