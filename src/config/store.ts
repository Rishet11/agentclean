import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configPath, absolutePath } from "../core/paths.js";
import { defaultPolicy } from "../core/policy.js";
import { ensureDirectory } from "../core/filesystem.js";
import type { Category, ConfigFile, Policy } from "../core/types.js";

const categories = new Set<Category>(["worktrees", "ai-history", "ai-caches", "package-caches", "project-dependencies", "project-environments", "build-artifacts"]);

export function validatePolicy(value: unknown): Policy {
  if (!value || typeof value !== "object") throw new Error("invalid policy");
  const policy = value as Partial<Policy>;
  const safeCacheAgeDays = policy.safeCacheAgeDays;
  const historyAgeDays = policy.historyAgeDays;
  const worktreeInactiveDays = policy.worktreeInactiveDays;
  const autoCategories = policy.autoCategories;
  const autoProviders = policy.autoProviders;
  const worktreeRoots = policy.worktreeRoots;
  if (policy.version !== 1 || typeof safeCacheAgeDays !== "number" || !Number.isFinite(safeCacheAgeDays) || safeCacheAgeDays < 0 || typeof historyAgeDays !== "number" || !Number.isFinite(historyAgeDays) || historyAgeDays < 0 || typeof worktreeInactiveDays !== "number" || !Number.isFinite(worktreeInactiveDays) || worktreeInactiveDays < 0 || !Array.isArray(autoCategories) || !autoCategories.every((category) => categories.has(category)) || !Array.isArray(autoProviders) || !autoProviders.every((provider) => typeof provider === "string" && provider.length > 0) || !Array.isArray(worktreeRoots) || !worktreeRoots.every((root) => typeof root === "string" && root.length > 0)) throw new Error("invalid policy");
  return { version: 1, safeCacheAgeDays, historyAgeDays, worktreeInactiveDays, autoCategories: [...autoCategories], autoProviders: [...autoProviders], worktreeRoots: worktreeRoots.map((root) => absolutePath(root)) };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<ConfigFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.roots)) throw new Error("invalid config");
    const policy = validatePolicy(parsed.policy);
    if (!parsed.roots.every((root) => typeof root === "string" && root.length > 0)) throw new Error("invalid roots");
    const config: ConfigFile = { version: 1, roots: parsed.roots.map((root) => absolutePath(root)), policy };
    if (typeof parsed.allowProjectArtifacts === "boolean") config.allowProjectArtifacts = parsed.allowProjectArtifacts;
    return config;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, roots: [], policy: { ...defaultPolicy } };
    throw error;
  }
}

export async function saveConfig(config: ConfigFile, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = configPath(env);
  await ensureDirectory(path.dirname(target));
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
