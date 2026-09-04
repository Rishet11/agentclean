import type { Candidate, RestoreCost, RestoreTier } from "./types.js";

/**
 * Metadata contract: providers populate `metadata.hasLockfile` (project-dependencies),
 * `metadata.hasRequirements` (project-environments), and `metadata.unpushedCommits`
 * (worktrees). None of the current providers set these yet. Every read below is
 * defensive: an absent key is never treated as evidence of recoverability. Absent
 * lockfile/requirements evidence classifies as `irreplaceable`, never `cheap` — we
 * never assume a way back exists that we cannot see evidence for.
 */

function metaBool(candidate: Candidate, key: string): boolean | undefined {
  const value = candidate.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function metaString(candidate: Candidate, key: string): string | undefined {
  const value = candidate.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metaNumber(candidate: Candidate, key: string): number | undefined {
  const value = candidate.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function irreplaceable(): RestoreCost {
  return { tier: "irreplaceable", seconds: "unknown", method: "", needsNetwork: false, confidence: "unknown" };
}

const buildCommands: Record<string, string> = {
  dist: "npm run build",
  build: "npm run build",
  out: "npm run build",
  ".next": "next build",
  target: "cargo build --release",
  coverage: "npm test -- --coverage",
  ".turbo": "turbo run build",
};

function buildRestoreMethod(candidate: Candidate): string {
  const name = metaString(candidate, "artifactName");
  return (name && buildCommands[name]) || "the project's build command";
}

function dependencyRestoreMethod(candidate: Candidate): string {
  const lockfile = metaString(candidate, "lockfile");
  if (lockfile === "pnpm-lock.yaml") return "pnpm install";
  if (lockfile === "yarn.lock") return "yarn install";
  return "npm ci";
}

function environmentRestoreMethod(candidate: Candidate): string {
  const requirementsFile = metaString(candidate, "requirementsFile");
  if (requirementsFile === "uv.lock") return "uv sync";
  if (requirementsFile === "pyproject.toml") return "uv pip install -e .";
  return "uv pip install -r requirements.txt";
}

function estimateBuildSeconds(candidate: Candidate): number {
  if (candidate.fileCount > 0) return Math.round(clamp(candidate.fileCount / 20, 5, 300));
  return 30;
}

function estimateDependencySeconds(candidate: Candidate): number {
  // fileCount is a good proxy for node_modules / site-packages reinstall time.
  if (candidate.fileCount > 0) return Math.round(clamp(candidate.fileCount / 40, 15, 1_800));
  return 120;
}

function estimateCacheSeconds(candidate: Candidate): number {
  if (candidate.fileCount > 0) return Math.round(clamp(candidate.fileCount / 200, 5, 120));
  return 15;
}

function estimateWorktreeSeconds(candidate: Candidate): number {
  if (candidate.fileCount > 0) return Math.round(clamp(candidate.fileCount / 100, 3, 60));
  return 5;
}

function needsNetworkGuess(candidate: Candidate): boolean {
  const haystack = `${candidate.reason} ${candidate.evidence.join(" ")}`.toLowerCase();
  return /download|fetch|remote|registry|network|sync/.test(haystack);
}

export function restoreCostFor(candidate: Candidate): RestoreCost {
  switch (candidate.category) {
    case "build-artifacts":
      return { tier: "free", seconds: estimateBuildSeconds(candidate), method: buildRestoreMethod(candidate), needsNetwork: false, confidence: "estimated" };

    case "package-caches": {
      const method = candidate.target.kind === "command" ? candidate.target.command.join(" ") : "the provider's prune command";
      return { tier: "cheap", seconds: estimateCacheSeconds(candidate), method, needsNetwork: true, confidence: "estimated" };
    }

    case "project-dependencies": {
      if (metaBool(candidate, "hasLockfile") === true) {
        return { tier: "cheap", seconds: estimateDependencySeconds(candidate), method: dependencyRestoreMethod(candidate), needsNetwork: true, confidence: "estimated" };
      }
      return irreplaceable();
    }

    case "project-environments": {
      if (metaBool(candidate, "hasRequirements") === true) {
        return { tier: "cheap", seconds: estimateDependencySeconds(candidate), method: environmentRestoreMethod(candidate), needsNetwork: true, confidence: "estimated" };
      }
      // A .venv with no requirements/pyproject/uv.lock evidence beside it is the
      // only record of what was installed. Getting this wrong loses a user's work.
      return irreplaceable();
    }

    case "worktrees": {
      const worktreePath = metaString(candidate, "worktreePath") || "<path>";
      const branch = metaString(candidate, "branch") || "<branch>";
      const base = `git worktree add ${worktreePath} ${branch}`;
      const unpushed = metaNumber(candidate, "unpushedCommits");
      const method = unpushed && unpushed > 0 ? `WARNING: ${unpushed} unpushed commit(s) will be lost. ${base}` : base;
      return { tier: "cheap", seconds: estimateWorktreeSeconds(candidate), method, needsNetwork: false, confidence: "estimated" };
    }

    case "ai-caches":
      return { tier: "cheap", seconds: estimateCacheSeconds(candidate), method: "provider re-creates this on demand", needsNetwork: needsNetworkGuess(candidate), confidence: "estimated" };

    case "ai-history":
      return irreplaceable();

    default:
      return irreplaceable();
  }
}

export function tierRank(tier: RestoreTier): number {
  return tier === "free" ? 0 : tier === "cheap" ? 1 : 2;
}

export const tierLabel: Record<RestoreTier, string> = {
  free: "Free to rebuild",
  cheap: "Cheap to restore",
  irreplaceable: "Irreplaceable",
};

export const tierSentence: Record<RestoreTier, string> = {
  free: "offline, seconds each",
  cheap: "needs network or a rebuild step, usually minutes",
  irreplaceable: "no way back — review before deleting",
};
