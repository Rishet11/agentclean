import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDirectory } from "./filesystem.js";

export interface LockOwner {
  pid: number;
  ppid: number;
  startedAt: string;
  hostname: string;
  version: string;
}

export interface LockOptions {
  /** Steal a lock held by a foreign hostname. Only escape hatch for that case. */
  forceUnlock?: boolean;
}

const staleOwnerFileAgeMs = 60_000;
const maxRunAgeMs = 6 * 60 * 60 * 1000;

/** process.kill(pid, 0) throws ESRCH when dead, EPERM when alive but owned by another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<LockOwner>;
  if (typeof parsed.pid !== "number" || typeof parsed.hostname !== "string" || typeof parsed.startedAt !== "string") return undefined;
  return { pid: parsed.pid, ppid: typeof parsed.ppid === "number" ? parsed.ppid : 0, startedAt: parsed.startedAt, hostname: parsed.hostname, version: typeof parsed.version === "string" ? parsed.version : "unknown" };
}

export interface LockCheck {
  stale: boolean;
  foreignHost: boolean;
  reason: string;
}

export async function evaluateLock(lockPath: string): Promise<LockCheck> {
  const owner = await readOwner(lockPath).catch(() => undefined);
  if (!owner) {
    const stats = await stat(lockPath);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > staleOwnerFileAgeMs) return { stale: true, foreignHost: false, reason: "owner.json missing or unreadable and lock is over 60s old" };
    return { stale: false, foreignHost: false, reason: "lock was just created; owner.json not written yet" };
  }
  if (owner.hostname !== os.hostname()) return { stale: false, foreignHost: true, reason: `held by pid ${owner.pid} on host ${owner.hostname}` };
  if (!isProcessAlive(owner.pid)) return { stale: true, foreignHost: false, reason: `pid ${owner.pid} is dead` };
  const startedAtMs = Date.parse(owner.startedAt);
  if (Number.isFinite(startedAtMs) && Date.now() - startedAtMs > maxRunAgeMs) return { stale: true, foreignHost: false, reason: `pid ${owner.pid} started over 6h ago, likely pid reuse` };
  return { stale: false, foreignHost: false, reason: `pid ${owner.pid} is alive` };
}

function sameOwner(a: LockOwner, b: LockOwner | undefined): boolean {
  return b !== undefined && a.pid === b.pid && a.startedAt === b.startedAt && a.hostname === b.hostname;
}

async function acquireLock(lockPath: string, options: LockOptions): Promise<void> {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const check = await evaluateLock(lockPath);
    if (check.foreignHost && !options.forceUnlock) throw new Error(`lock is ${check.reason}; use --force-unlock to override`);
    if (!check.stale && !check.foreignHost) throw new Error(`another cleanup run is active: ${lockPath} (${check.reason})`);
    process.stderr.write(`reclaiming lock at ${lockPath}: ${check.reason}\n`);
    await rm(lockPath, { recursive: true, force: true });
    try {
      await mkdir(lockPath);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`another cleanup run is active: ${lockPath} (lost race to reclaim it)`);
      throw retryError;
    }
  }
  const owner: LockOwner = { pid: process.pid, ppid: process.ppid, startedAt: new Date().toISOString(), hostname: os.hostname(), version: process.env.npm_package_version || "unknown" };
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  // Two racing reclaimers can both pass the mkdir/EEXIST gate above (each removes
  // and recreates the same stale directory in turn). Re-read what is on disk now:
  // if it isn't the owner record we just wrote, another process won the race.
  const settled = await readOwner(lockPath).catch(() => undefined);
  if (!sameOwner(owner, settled)) throw new Error(`another cleanup run is active: ${lockPath} (lost race while acquiring)`);
}

export async function withExecutionLock<T>(runDir: string, operation: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  await ensureDirectory(runDir);
  const lockPath = path.join(runDir, "execution.lock");
  await acquireLock(lockPath, options);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await rm(lockPath, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    release().finally(() => {
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    return await operation();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    await release();
  }
}
