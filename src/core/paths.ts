import { homedir } from "node:os";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

export function homePath(...parts: string[]): string {
  return path.join(homedir(), ...parts);
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || env.APPDATA || homedir(), "agentclean");
  }
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "agentclean");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return path.join(env.APPDATA || env.LOCALAPPDATA || homedir(), "agentclean", "config.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agentclean", "config.json");
}

export function absolutePath(value: string, cwd = process.cwd()): string {
  return path.resolve(cwd, value);
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isWithinAny(roots: string[], candidate: string): boolean {
  return roots.some((root) => isWithin(root, candidate));
}

export async function safeRealPath(value: string): Promise<string | undefined> {
  try {
    return await realpath(value);
  } catch {
    return undefined;
  }
}

export async function isSafePath(value: string, allowedRoot: string): Promise<boolean> {
  if (!isWithin(allowedRoot, value)) return false;
  let stats;
  try {
    stats = await lstat(value);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  const resolved = await safeRealPath(value);
  if (!resolved) return false;
  return isWithin(allowedRoot, resolved);
}

export function displayPath(value: string): string {
  const home = comparisonPath(homedir());
  const current = comparisonPath(value);
  if (current === home) return "~";
  if (current.startsWith(`${home}${path.sep}`)) return `~${value.slice(homedir().length)}`;
  return value;
}
