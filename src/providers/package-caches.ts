import { CommandProvider } from "./command.js";

/**
 * Deliberately not provided here, and why:
 *
 * - cargo: stable cargo has no built-in cache-clean command. The registry
 *   cache lives at `$CARGO_HOME/registry` (default `~/.cargo/registry`,
 *   confirmed in doc.rust-lang.org/cargo/guide/cargo-home.html), and Cargo's
 *   own docs say any part of it can be removed and redownloaded/re-extracted
 *   on demand — but there is no cargo command that *reports* that path, so it
 *   cannot be wired through CommandProvider without hardcoding a path cargo
 *   never told us (exactly the "name-matching delete" this codebase forbids).
 *   The third-party `cargo-cache` plugin (`cargo cache`) has an autoclean
 *   command (`cargo cache --autoclean`, verified against its GitHub README)
 *   safe enough to run, but its only path-reporting flag, `--list-dirs`,
 *   prints every cache subdirectory it knows about (registry, git, index,
 *   src...), not a single canonical path — there is no verified way to know
 *   which line is "the" cache dir without guessing. Left out rather than
 *   guessed; not installed on this machine either way.
 * - maven: no cache command exists (confirmed by design of this task and by
 *   research); the repository is `~/.m2/repository` with nothing to ask maven
 *   for that path and no maven-native, integrity-aware way to clear it.
 * - gradle: same shape as maven — `~/.gradle/caches` is well known, but there
 *   is no gradle command that reports or safely clears it globally.
 *
 * All three: under-covering is the honest choice over inventing a delete.
 */

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
