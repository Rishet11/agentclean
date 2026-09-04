import { CommandProvider } from "./command.js";

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

export { parseCachePath } from "./command.js";
