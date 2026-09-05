import path from "node:path";
import { lstat } from "node:fs/promises";
import { CommandProvider } from "./command.js";
import { measureTree, removeTree } from "../core/filesystem.js";
import { fingerprintFromStats, type ActionResult, type Candidate, type ExecuteContext, type ProviderDetection, type StorageProvider, type Validation } from "../core/types.js";
import { hashValue } from "../core/plan.js";
import { isWithin, safeRealPath, samePath } from "../core/paths.js";

/**
 * Revisited with research (see the report this shipped with for full
 * citations): cargo and gradle are now implemented below; maven stays out,
 * for a more precise reason than before.
 *
 * - cargo: `$CARGO_HOME` (default `~/.cargo`) is Cargo's own documented
 *   override env var (doc.rust-lang.org/cargo/guide/cargo-home.html) — the
 *   same "env var with a documented default" shape already used for Codex
 *   (`CODEX_HOME`) in ai.ts, not a bare guess. That page's current wording:
 *   "In theory, you can always remove any part of the cache and Cargo will
 *   do its best to restore sources if a crate needs them either by
 *   reextracting an archive or checking out a bare repo or by simply
 *   redownloading the sources from the web," and it names the directories:
 *   `registry/cache` (downloaded .crate archives), `registry/src` (unpacked
 *   sources), `git/db` (bare clones of git dependencies), `git/checkouts`
 *   (their checked-out commits). Stable cargo still has no subcommand that
 *   reports or clears this path — an automatic cache-gc stabilized in cargo
 *   1.88 that runs on its own during normal use, but manual `cargo clean gc`
 *   still requires the unstable `-Z gc` flag as of this research — so there
 *   is still nothing to delegate cleanup to via CommandProvider. Implemented
 *   below directly against the four documented subdirectories instead: the
 *   same "verified env-var root, fixed documented-safe children" shape the
 *   AI-tool FilesystemProviders in ai.ts already use, not a CommandProvider,
 *   because there is no command to wrap.
 * - gradle: `GRADLE_USER_HOME` (default `~/.gradle`) is likewise Gradle's own
 *   documented override env var
 *   (docs.gradle.org/current/userguide/directory_layout.html, Gradle 9.7.1
 *   docs at the time of this research). That page names specific
 *   subdirectories under `caches/` and says "Gradle creates, uses, and
 *   cleans them automatically": `caches/modules-2` (downloaded module
 *   dependencies), `caches/jars-9` (instrumented jars), `caches/transforms-3`
 *   (artifact transform outputs), `caches/build-cache-1` (local build
 *   cache). The numeric suffixes are Gradle's own internal cache-format
 *   version and will move on a future Gradle release — verified for the
 *   Gradle version that page describes, not guaranteed for every installed
 *   version; a mismatch just means nothing is found there, never a wrong
 *   delete (this tool is not installed on the machine this was written on,
 *   so none of this could be exercised live either way). No gradle CLI
 *   invocation was found that reports GRADLE_USER_HOME or a cache path
 *   without an existing project present, so — like cargo — this is a direct,
 *   fixed-path provider rather than a CommandProvider.
 * - maven: still left out. `~/.m2/repository` (or `<localRepository>` in
 *   settings.xml) has no environment-variable override — `M2_HOME` is the
 *   Maven *install* location, not the repository, and Maven documents no env
 *   var for the repository path. A path-reporting command does exist
 *   (`mvn help:evaluate -Dexpression=settings.localRepository -q
 *   -DforceStdout`, documented by the maven-help-plugin, and it works with
 *   no project present) — but the only cleanup goal,
 *   `dependency:purge-local-repository` (maven-dependency-plugin docs),
 *   does not pair with it. Its own goal description: "When run on a
 *   project, remove the project dependencies from the local repository, and
 *   optionally re-resolve them. Outside of a project, remove the manually
 *   given dependencies." This tool runs against a user's home directory, not
 *   from inside one Maven project, and has no pre-known artifact list to
 *   hand the goal's `manualIncludes` parameter — so outside of a project
 *   there is nothing for it to purge, and there is no documented way to
 *   purge the repository as a whole. A path-reporting command with no
 *   matching whole-repository-safe cleanup command is still nothing to wire
 *   up.
 *
 * Under-covering is the honest choice over inventing a delete.
 */

/**
 * A root resolved from a tool-documented environment variable (with a
 * documented default), paired with a fixed list of subdirectories that
 * tool's own docs describe as safe to delete and automatically recreated.
 * Each entry is reported and removed as one whole directory — never
 * enumerated into arbitrary children the way FilesystemProvider's
 * DisposableRoot is in ai.ts — so there is no name-matching risk against
 * anything else living in the same root (cargo's credentials.toml /
 * config.toml, gradle.properties, and so on are simply never looked at, by
 * construction, not by an exclusion list).
 */
interface DocumentedCacheEntry {
  segments: string[];
  reason: string;
  evidence: string[];
}

class DocumentedCacheProvider implements StorageProvider {
  readonly status = "verified" as const;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly rootResolver: (context: ExecuteContext) => string,
    private readonly entries: DocumentedCacheEntry[],
  ) {}

  async detect(context: ExecuteContext): Promise<ProviderDetection> {
    const root = this.rootResolver(context);
    const exists = await safeRealPath(root);
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      details: exists ? "documented data root" : "documented data root not present",
      root: exists,
      capabilities: this.entries.map((entry) => `package-caches:${entry.segments.join("/")}`),
    };
  }

  async discover(context: ExecuteContext): Promise<Candidate[]> {
    const root = this.rootResolver(context);
    if (!(await safeRealPath(root))) return [];
    const candidates: Candidate[] = [];
    for (const entry of this.entries) {
      const target = path.join(root, ...entry.segments);
      let stats;
      try {
        stats = await lstat(target);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      const measured = await measureTree(target).catch(() => undefined);
      if (!measured) continue;
      candidates.push({
        id: hashValue({ provider: this.id, target, category: "package-caches" }).slice(0, 16),
        provider: this.id,
        providerStatus: this.status,
        category: "package-caches",
        action: "delete",
        target: { kind: "path", path: target },
        reason: entry.reason,
        evidence: entry.evidence,
        bytes: measured.bytes,
        fileCount: measured.fileCount,
        mtimeMs: stats.mtimeMs,
        fingerprint: fingerprintFromStats(stats),
        eligible: true,
        blockers: [],
        autoSafe: false,
        partialMeasurement: measured.partial,
        metadata: { root, segments: entry.segments.join("/") },
      });
    }
    return candidates;
  }

  explain(candidate: Candidate): string {
    return `${candidate.reason}. Documented as safe to remove; ${this.name} re-creates it the next time it is needed.`;
  }

  async revalidate(candidate: Candidate, context: ExecuteContext): Promise<Validation> {
    if (candidate.target.kind !== "path") return { ok: false, reason: "path required" };
    const root = this.rootResolver(context);
    const segments = typeof candidate.metadata?.segments === "string" ? candidate.metadata.segments.split("/") : undefined;
    if (!segments) return { ok: false, reason: "missing provider metadata" };
    const expected = path.join(root, ...segments);
    if (!isWithin(root, expected) || !samePath(expected, candidate.target.path)) return { ok: false, reason: "path outside documented provider entry" };
    if (!(await safeRealPath(candidate.target.path))) return { ok: false, reason: "path missing" };
    let stats;
    try {
      stats = await lstat(candidate.target.path);
    } catch {
      return { ok: false, reason: "path missing" };
    }
    if (stats.isSymbolicLink()) return { ok: false, reason: "reparse-point" };
    if (!candidate.fingerprint || stats.size !== candidate.fingerprint.size || stats.mtimeMs !== candidate.fingerprint.mtimeMs || stats.isDirectory() !== (candidate.fingerprint.kind === "directory")) {
      return { ok: false, reason: "changed-since-scan" };
    }
    const measured = await measureTree(candidate.target.path).catch(() => undefined);
    if (!measured) return { ok: false, reason: "contents-changed-since-scan" };
    if (measured.partial) return { ok: false, reason: "partial-measurement" };
    if (measured.bytes !== candidate.bytes || measured.fileCount !== candidate.fileCount) return { ok: false, reason: "contents-changed-since-scan" };
    return { ok: true };
  }

  async execute(candidate: Candidate): Promise<ActionResult> {
    if (candidate.target.kind !== "path") return { ok: false, bytes: 0, reason: "path required" };
    await removeTree(candidate.target.path);
    return { ok: true, bytes: candidate.bytes };
  }
}

function cargoRoot(context: ExecuteContext): string {
  // Verified: CARGO_HOME overrides Cargo's cache/config root, defaulting to
  // ~/.cargo (doc.rust-lang.org/cargo/guide/cargo-home.html).
  return context.env.CARGO_HOME ? path.resolve(context.env.CARGO_HOME) : path.join(context.home, ".cargo");
}

const CARGO_HOME_EVIDENCE = "CARGO_HOME env var, default ~/.cargo (doc.rust-lang.org/cargo/guide/cargo-home.html)";
const CARGO_SAFE_EVIDENCE = 'cargo docs: "you can always remove any part of the cache"; re-extracted or redownloaded on demand';

const cargoEntries: DocumentedCacheEntry[] = [
  { segments: ["registry", "cache"], reason: "cargo downloaded crate archives (registry/cache)", evidence: [CARGO_HOME_EVIDENCE, CARGO_SAFE_EVIDENCE] },
  { segments: ["registry", "src"], reason: "cargo unpacked crate sources (registry/src)", evidence: [CARGO_HOME_EVIDENCE, CARGO_SAFE_EVIDENCE] },
  { segments: ["git", "db"], reason: "cargo git-dependency bare clones (git/db)", evidence: [CARGO_HOME_EVIDENCE, CARGO_SAFE_EVIDENCE] },
  { segments: ["git", "checkouts"], reason: "cargo git-dependency checkouts (git/checkouts)", evidence: [CARGO_HOME_EVIDENCE, CARGO_SAFE_EVIDENCE] },
];

/**
 * No stable cargo subcommand reports or clears this path (see file header),
 * so this deletes the documented subdirectories directly rather than
 * delegating to a provider command. Full wipe, not a prune, so not
 * auto-safe. Not installed on the machine this was written on — unverified
 * live, verified against current cargo documentation only.
 */
export function cargoProvider(): StorageProvider {
  return new DocumentedCacheProvider("cargo", "cargo", cargoRoot, cargoEntries);
}

function gradleRoot(context: ExecuteContext): string {
  // Verified: GRADLE_USER_HOME overrides Gradle's cache/config root,
  // defaulting to ~/.gradle
  // (docs.gradle.org/current/userguide/directory_layout.html).
  return context.env.GRADLE_USER_HOME ? path.resolve(context.env.GRADLE_USER_HOME) : path.join(context.home, ".gradle");
}

const GRADLE_HOME_EVIDENCE = "GRADLE_USER_HOME env var, default ~/.gradle (docs.gradle.org/current/userguide/directory_layout.html)";
const GRADLE_SAFE_EVIDENCE = 'gradle docs: "Gradle creates, uses, and cleans them automatically"; recreated on first use of that Gradle version';

const gradleEntries: DocumentedCacheEntry[] = [
  { segments: ["caches", "modules-2"], reason: "Gradle downloaded module dependencies (caches/modules-2)", evidence: [GRADLE_HOME_EVIDENCE, GRADLE_SAFE_EVIDENCE] },
  { segments: ["caches", "jars-9"], reason: "Gradle instrumented jar cache (caches/jars-9)", evidence: [GRADLE_HOME_EVIDENCE, GRADLE_SAFE_EVIDENCE] },
  { segments: ["caches", "transforms-3"], reason: "Gradle artifact transform outputs (caches/transforms-3)", evidence: [GRADLE_HOME_EVIDENCE, GRADLE_SAFE_EVIDENCE] },
  { segments: ["caches", "build-cache-1"], reason: "Gradle local build cache (caches/build-cache-1)", evidence: [GRADLE_HOME_EVIDENCE, GRADLE_SAFE_EVIDENCE] },
];

/**
 * The `-2`/`-9`/`-3`/`-1` suffixes are Gradle's own cache-format version
 * numbers (see file header) for the Gradle release its current docs
 * describe; an installed Gradle with different numbers simply contributes
 * nothing here, never a wrong match. No gradle command reports this path
 * without a project present, so — like cargo — this deletes the documented
 * subdirectories directly. Full wipe, not auto-safe. Not installed on the
 * machine this was written on — unverified live, verified against current
 * Gradle documentation only.
 */
export function gradleProvider(): StorageProvider {
  return new DocumentedCacheProvider("gradle", "gradle", gradleRoot, gradleEntries);
}

/**
 * `uv cache prune` removes only unreachable entries; it is uv's own maintenance
 * command, not an "empty the cache" hammer. Not auto-safe: pruning is still a
 * one-way trip for anything it decides is unreachable.
 */
export function uvProvider(): CommandProvider {
  return new CommandProvider("uv", "uv", ["uv", "cache", "dir"], ["uv", "cache", "prune"], "uv package cache", false);
}

/**
 * `go clean -modcache` is a full wipe, not a prune — the restore cost is a full
 * re-download of every module version ever fetched. Not auto-safe.
 */
export function goProvider(): CommandProvider {
  return new CommandProvider("go", "go", ["go", "env", "GOMODCACHE"], ["go", "clean", "-modcache"], "Go module cache", false, { versionCommand: ["go", "version"] });
}

/**
 * Yarn classic (v1) only. `yarn cache dir` / `yarn cache clean` are v1-only
 * commands (verified against classic.yarnpkg.com); Berry (v2+) replaced them
 * with `yarn config get cacheFolder`, whose value defaults to the *project*
 * cache (`./.yarn/cache`) rather than a global store, and can be a directory
 * checked into git for PnP zero-installs — cleaning it is not a generic-cache
 * operation and is deliberately not implemented here. Community reports (e.g.
 * github.com/actions/setup-node#441) say `yarn cache dir` exits non-zero
 * ("unrecognized command") against a Berry-resolved `yarn` binary, which would
 * make discover() degrade to no candidates rather than touching the wrong
 * directory — plausible given CommandProvider's non-zero-exit handling, but
 * unverified here: yarn is not installed on this machine, so this exact path
 * was never actually run. Full wipe, not a prune, so not auto-safe.
 */
export function yarnProvider(): CommandProvider {
  return new CommandProvider("yarn", "yarn", ["yarn", "cache", "dir"], ["yarn", "cache", "clean"], "yarn package cache (classic v1 only)", false);
}

/**
 * `bun pm cache` (no args) prints the global module cache path; `bun pm cache
 * rm` clears it (verified against bun.com/docs/pm/cli/pm). An older bun had a
 * flag-parsing bug where `rm` was shadowed by the parent command (oven-sh/bun
 * #1720), fixed by oven-sh/bun#4571; current releases execute the deletion.
 * Full wipe, not auto-safe.
 */
export function bunProvider(): CommandProvider {
  return new CommandProvider("bun", "bun", ["bun", "pm", "cache"], ["bun", "pm", "cache", "rm"], "bun package cache", false);
}

/**
 * `pip cache dir` / `pip cache purge` (verified live on this machine, pip
 * 26.2.1, via `pip3 --help`). The path command deliberately runs `pip3`, not
 * `pip`: this machine (Homebrew Python on macOS) has no plain `pip` on PATH at
 * all, only `pip3`/`pip3.x`, which is also the common case on many Linux
 * distros that ship only a python3 pip. A bare `pip` does exist inside most
 * virtualenvs/conda envs, so this under-covers that case in exchange for
 * covering the more common bare-system case — a real trade-off, not a fixed
 * "right" answer. Full wipe, not a prune, so not auto-safe.
 */
export function pipProvider(): CommandProvider {
  return new CommandProvider("pip", "pip", ["pip3", "cache", "dir"], ["pip3", "cache", "purge"], "pip wheel cache", false);
}

export { parseCachePath } from "./command.js";
