import path from "node:path";
import { runCommand } from "../core/command.js";

export interface SchedulerStatus { installed: boolean; details: string; }

const taskName = "AgentClean";

function taskCommand(executable: string, script: string): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(executable)} ${quote(script)} auto --once`;
}

export async function installScheduler(executable: string, script: string, interval: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("automatic scheduling is not implemented on this platform yet");
  if (!path.isAbsolute(executable) || !path.isAbsolute(script)) throw new Error("scheduled executable and script must be absolute paths");
  const schedule = interval === "daily" ? "DAILY" : interval === "weekly" ? "WEEKLY" : undefined;
  if (!schedule) throw new Error("interval must be daily or weekly");
  const result = await runCommand(["schtasks", "/Create", "/F", "/SC", schedule, "/TN", taskName, "/TR", taskCommand(executable, script), "/RL", "LIMITED"], undefined, 30_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "could not install Task Scheduler task");
}

export async function uninstallScheduler(): Promise<void> {
  if (process.platform !== "win32") throw new Error("automatic scheduling is not implemented on this platform yet");
  const result = await runCommand(["schtasks", "/Delete", "/F", "/TN", taskName], undefined, 30_000);
  if (result.code !== 0 && !/does not exist|cannot find/i.test(result.stderr)) throw new Error(result.stderr.trim() || "could not remove Task Scheduler task");
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  if (process.platform !== "win32") return { installed: false, details: "not implemented on this platform" };
  const result = await runCommand(["schtasks", "/Query", "/TN", taskName], undefined, 30_000).catch(() => undefined);
  return result?.code === 0 ? { installed: true, details: taskName } : { installed: false, details: "not installed" };
}
