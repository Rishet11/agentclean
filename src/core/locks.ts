import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDirectory } from "./filesystem.js";

export async function withExecutionLock<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
  await ensureDirectory(runDir);
  const lockPath = path.join(runDir, "execution.lock");
  try {
    await mkdir(lockPath);
  } catch {
    throw new Error(`another cleanup run is active: ${lockPath}`);
  }
  try {
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
