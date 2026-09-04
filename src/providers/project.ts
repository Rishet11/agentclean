import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fingerprintFromStats, type Candidate, type ExecuteContext, type StorageProvider, type Validation } from "../core/types.js";
import { immediateChildren, measureTree, removeTree } from "../core/filesystem.js";
import { hashValue } from "../core/plan.js";
import { isWithin, isWithinAny, safeRealPath, samePath } from "../core/paths.js";

interface ArtifactRule {
  name: string;
  category: "project-dependencies" | "project-environments" | "build-artifacts";
  reason: string;
  minAgeDays: number;
  evidence: string[];
}

const packageLocks = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const projectMarkers = ["package.json", "pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];
const ignoredDirectories = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "vendor", "target"]);

const rules: ArtifactRule[] = [
  { name: "node_modules", category: "project-dependencies", reason: "rebuildable JavaScript dependencies", minAgeDays: 14, evidence: ["package.json", "package lockfile"] },
  { name: ".venv", category: "project-environments", reason: "Python virtual environment", minAgeDays: 14, evidence: ["Python project marker", "pyvenv.cfg"] },
  { name: "venv", category: "project-environments", reason: "Python virtual environment", minAgeDays: 14, evidence: ["Python project marker", "pyvenv.cfg"] },
  { name: "env", category: "project-environments", reason: "Python virtual environment", minAgeDays: 14, evidence: ["Python project marker", "pyvenv.cfg"] },
  { name: "dist", category: "build-artifacts", reason: "generated build output", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
  { name: "build", category: "build-artifacts", reason: "generated build output", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
  { name: ".next", category: "build-artifacts", reason: "generated Next.js output", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
  { name: "out", category: "build-artifacts", reason: "generated export output", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
  { name: "target", category: "build-artifacts", reason: "generated build output", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
  { name: "coverage", category: "build-artifacts", reason: "generated test coverage output", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
  { name: ".turbo", category: "build-artifacts", reason: "rebuildable Turborepo cache", minAgeDays: 7, evidence: ["recognized project root", "known build directory"] },
];

function hasFile(root: string, name: string): Promise<boolean> {
  return lstat(path.join(root, name)).then((stats) => stats.isFile()).catch(() => false);
}

async function isProjectRoot(root: string): Promise<boolean> {
  if (await hasFile(root, ".git")) return true;
  for (const marker of projectMarkers) if (await hasFile(root, marker)) return true;
  return false;
}

async function isPythonEnvironment(target: string): Promise<boolean> {
  return await hasFile(target, "pyvenv.cfg");
}

async function projectRoots(roots: string[]): Promise<string[]> {
  const found = new Set<string>();
  const visited = new Set<string>();
  let directories = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 5 || directories >= 10_000 || visited.has(current)) return;
    visited.add(current);
    const info = await lstat(current).catch(() => undefined);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
    const resolved = await safeRealPath(current);
    if (!resolved) return;
    directories += 1;
    if (await isProjectRoot(resolved)) found.add(resolved);
    const entries = await readdir(resolved).catch(() => [] as string[]);
    for (const entry of entries) {
      if (ignoredDirectories.has(entry)) continue;
      await visit(path.join(resolved, entry), depth + 1);
    }
  };
  for (const root of roots) await visit(path.resolve(root), 0);
  return [...found];
}

function fingerprintMatches(candidate: Candidate, current: Awaited<ReturnType<typeof lstat>>): boolean {
  const fingerprint = candidate.fingerprint;
  if (!fingerprint || fingerprint.kind !== (current.isDirectory() ? "directory" : "file")) return false;
  if (fingerprint.size !== current.size || fingerprint.mtimeMs !== current.mtimeMs) return false;
  if (fingerprint.dev !== undefined && fingerprint.dev !== current.dev) return false;
  if (fingerprint.ino !== undefined && fingerprint.ino !== current.ino) return false;
  return true;
}

export class ProjectArtifactProvider implements StorageProvider {
  readonly id = "project";
  readonly name = "Project artifacts";
  readonly status = "verified" as const;

  async detect(context: ExecuteContext) {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      details: context.allowProjectArtifacts ? "project-root artifact scan enabled" : "enable with --project-artifacts or a project category",
      capabilities: rules.map((rule) => rule.category),
    };
  }

  async discover(context: ExecuteContext): Promise<Candidate[]> {
    if (!context.allowProjectArtifacts) return [];
    const output: Candidate[] = [];
    for (const root of await projectRoots(context.roots)) {
      const children = await immediateChildren(root).catch(() => []);
      for (const target of children) {
        const name = path.basename(target);
        const matchingRules = rules.filter((rule) => rule.name === name);
        if (matchingRules.length === 0) continue;
        const stats = await lstat(target).catch(() => undefined);
        if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) continue;
        for (const rule of matchingRules) {
          if (rule.category === "project-dependencies" && (!(await hasFile(root, "package.json")) || !(await packageLocks.some((lock) => hasFile(root, lock))))) continue;
          if (rule.category === "project-environments" && !(await isPythonEnvironment(target))) continue;
          const measured = await measureTree(target).catch(() => undefined);
          if (!measured) continue;
          const ageDays = Math.max(0, (context.now - stats.mtimeMs) / 86_400_000);
          const blockers = ageDays < rule.minAgeDays ? [`younger-than-${rule.minAgeDays}-days`] : [];
          if (isWithinAny([target], context.cwd)) blockers.push("current-directory");
          output.push({
            id: hashValue({ provider: this.id, root, name, category: rule.category }).slice(0, 16),
            provider: this.id,
            providerStatus: this.status,
            category: rule.category,
            action: "delete",
            target: { kind: "path", path: target },
            reason: `${rule.reason}: ${path.basename(root)}/${name}`,
            evidence: rule.evidence,
            bytes: measured.bytes,
            fileCount: measured.fileCount,
            mtimeMs: stats.mtimeMs,
            fingerprint: fingerprintFromStats(stats),
            eligible: blockers.length === 0,
            blockers,
            autoSafe: false,
            metadata: { projectRoot: root, artifactName: name, minAgeDays: rule.minAgeDays },
          });
        }
      }
    }
    return output;
  }

  explain(candidate: Candidate): string {
    return `${candidate.reason}. It was found below an explicit project root using positive manifest/environment evidence; project artifacts always require explicit review.`;
  }

  async revalidate(candidate: Candidate, context: ExecuteContext): Promise<Validation> {
    if (candidate.target.kind !== "path") return { ok: false, reason: "path required" };
    const root = candidate.metadata?.projectRoot;
    const artifactName = candidate.metadata?.artifactName;
    const minimumAge = candidate.metadata?.minAgeDays;
    if (typeof root !== "string" || typeof artifactName !== "string" || typeof minimumAge !== "number") return { ok: false, reason: "missing project metadata" };
    if (!context.allowProjectArtifacts || !isWithinAny(context.roots, root) || !await isProjectRoot(root)) return { ok: false, reason: "project root is not currently allowed" };
    const target = path.join(root, artifactName);
    if (!samePath(target, candidate.target.path)) return { ok: false, reason: "artifact path changed" };
    const stats = await lstat(target).catch(() => undefined);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return { ok: false, reason: "artifact missing or is a reparse point" };
    if (!fingerprintMatches(candidate, stats)) return { ok: false, reason: "changed-since-scan" };
    if (Math.max(0, (context.now - stats.mtimeMs) / 86_400_000) < minimumAge) return { ok: false, reason: `younger-than-${minimumAge}-days` };
    if (isWithin(target, context.cwd)) return { ok: false, reason: "current-directory" };
    if (artifactName === "node_modules" && (!(await hasFile(root, "package.json")) || !(await packageLocks.some((lock) => hasFile(root, lock))))) return { ok: false, reason: "package lock evidence missing" };
    if ([".venv", "venv", "env"].includes(artifactName) && !(await isPythonEnvironment(target))) return { ok: false, reason: "Python environment marker missing" };
    const measured = await measureTree(target).catch(() => undefined);
    if (!measured || measured.bytes !== candidate.bytes || measured.fileCount !== candidate.fileCount) return { ok: false, reason: "contents-changed-since-scan" };
    return { ok: true };
  }

  async execute(candidate: Candidate): Promise<{ ok: boolean; bytes: number; reason?: string }> {
    if (candidate.target.kind !== "path") return { ok: false, bytes: 0, reason: "path required" };
    await removeTree(candidate.target.path);
    return { ok: true, bytes: candidate.bytes };
  }
}
