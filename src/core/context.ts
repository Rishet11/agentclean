import { cwd as processCwd, env as processEnv } from "node:process";
import { homedir } from "node:os";
import type { ConfigFile, ExecuteContext } from "./types.js";
import { stateDir, absolutePath } from "./paths.js";

export function makeContext(config: ConfigFile, roots: string[] = [], cwd = processCwd(), env = processEnv, allowProjectArtifacts = false): ExecuteContext {
  const allRoots = [...new Set([cwd, ...config.roots, ...roots].map((root) => absolutePath(root, cwd)))];
  return { now: Date.now(), roots: allRoots, configRoots: config.roots, cwd, home: homedir(), env, policy: config.policy, allowProjectArtifacts: allowProjectArtifacts || config.allowProjectArtifacts === true, dryRun: false, runDir: stateDir(env) };
}
