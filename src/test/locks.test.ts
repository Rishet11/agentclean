import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isProcessAlive, withExecutionLock, type LockOwner } from "../core/locks.js";

async function tempRunDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentclean-lock-"));
}

async function seedLock(runDir: string, owner?: Partial<LockOwner>): Promise<string> {
  const lockPath = path.join(runDir, "execution.lock");
  await mkdir(lockPath);
  if (owner) {
    const full: LockOwner = { pid: process.pid, ppid: process.ppid, startedAt: new Date().toISOString(), hostname: os.hostname(), version: "0.0.0", ...owner };
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(full), "utf8");
  }
  return lockPath;
}

// pid 1 is init on POSIX and is owned by root, so signalling it from an
// unprivileged process raises EPERM, which is what makes it a usable probe
// for "the process exists but is not ours". Windows has no pid 1 at all, so
// process.kill(1, 0) raises ESRCH there and the probe means nothing. The
// implementation is unaffected: ESRCH-only-means-dead is correct on both.
const posixOnly = { skip: process.platform === "win32" ? "pid 1 is POSIX-specific" : false };

test("EPERM on pid 1 signals alive (verifies the ESRCH-only-means-dead assumption)", posixOnly, () => {
  assert.equal(isProcessAlive(1), true);
});

test("a lock owned by a live pid is not stolen", async () => {
  const runDir = await tempRunDir();
  await seedLock(runDir, { pid: process.pid, hostname: os.hostname() });
  await assert.rejects(withExecutionLock(runDir, async () => "ran"), /another cleanup run is active/);
});

test("an EPERM pid (pid 1) is treated as alive, not reclaimed", posixOnly, async () => {
  const runDir = await tempRunDir();
  await seedLock(runDir, { pid: 1, hostname: os.hostname() });
  await assert.rejects(withExecutionLock(runDir, async () => "ran"), /another cleanup run is active/);
});

test("a dead pid is reclaimed", async () => {
  const runDir = await tempRunDir();
  await seedLock(runDir, { pid: 999_999, hostname: os.hostname() });
  const result = await withExecutionLock(runDir, async () => "ran");
  assert.equal(result, "ran");
  const entries = await readdir(runDir).catch((): string[] => []);
  assert.equal(entries.includes("execution.lock"), false);
});

test("a pid that looks alive but started over 6h ago is reclaimed", async () => {
  const runDir = await tempRunDir();
  const staleStart = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  await seedLock(runDir, { pid: process.pid, hostname: os.hostname(), startedAt: staleStart });
  const result = await withExecutionLock(runDir, async () => "ran");
  assert.equal(result, "ran");
});

test("a foreign hostname refuses without --force-unlock", async () => {
  const runDir = await tempRunDir();
  await seedLock(runDir, { pid: process.pid, hostname: "some-other-machine" });
  await assert.rejects(withExecutionLock(runDir, async () => "ran"), /force-unlock/);
});

test("a foreign hostname reclaims with --force-unlock", async () => {
  const runDir = await tempRunDir();
  await seedLock(runDir, { pid: process.pid, hostname: "some-other-machine" });
  const result = await withExecutionLock(runDir, async () => "ran", { forceUnlock: true });
  assert.equal(result, "ran");
});

test("a missing owner.json with an old mtime reclaims", async () => {
  const runDir = await tempRunDir();
  const lockPath = await seedLock(runDir);
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  const result = await withExecutionLock(runDir, async () => "ran");
  assert.equal(result, "ran");
});

test("a missing owner.json with a fresh mtime refuses", async () => {
  const runDir = await tempRunDir();
  await seedLock(runDir);
  await assert.rejects(withExecutionLock(runDir, async () => "ran"), /another cleanup run is active/);
});
