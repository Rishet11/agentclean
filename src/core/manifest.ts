import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunResult } from "./types.js";
import { stateDir } from "./paths.js";

export async function latestManifest(env: NodeJS.ProcessEnv = process.env): Promise<RunResult | undefined> {
  const directory = stateDir(env);
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(directory)).catch(() => [] as string[]);
  const files = entries.filter((entry) => entry.startsWith("run-") && entry.endsWith(".json")).sort().reverse();
  if (!files[0]) return undefined;
  try { return JSON.parse(await readFile(path.join(directory, files[0]), "utf8")) as RunResult; } catch { return undefined; }
}
