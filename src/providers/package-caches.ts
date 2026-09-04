import path from "node:path";
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
  return new CommandProvider("go", "go", ["go", "env", "GOMODCACHE"], ["go", "clean", "-modcache"], "Go module cache", false);
}

/**
 * Correct replacement for the path parsing in command.ts:31
 * (`result.stdout.trim().split(/\r?\n/).pop()?.trim()`), which blindly takes the
 * last line of stdout and will accept a trailing warning line as the cache path.
 * This picks the last line that actually looks like an absolute path, falling
 * back to the old "last line" behavior only when nothing matches.
 *
 * NOT wired into CommandProvider — command.ts is out of scope here (owned by
 * another agent). This is exported so command.ts:31 can be fixed to call it.
 */
export function parseCachePath(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (path.isAbsolute(line) || /^[a-zA-Z]:[\\/]/.test(line)) return line;
  }
  return lines.pop();
}
