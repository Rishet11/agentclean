import { cwd as processCwd, env as processEnv } from "node:process";
import { homedir } from "node:os";
import type { ConfigFile, ExecuteContext } from "./types.js";
import { stateDir, absolutePath } from "./paths.js";
import { discoverRoots } from "./roots.js";

/**
 * `allowProjectArtifacts` used to be the single flag gating both whether project
 * artifacts (node_modules, .venv, build output) show up in a scan at all, and
 * whether they are eligible for deletion. Discovery is read-only and protects
 * nothing, so gating discovery on it is what makes a first run report ~0 bytes
 * of a machine's actual biggest sink. This module-augments `ScanContext`
 * (declared in ./types.ts, which this file does not edit) with an additive
 * second field so the two concepts can be split without touching that file or
 * breaking its other consumers:
 *
 *  - `reportProjectArtifacts`: whether project artifacts appear in scan output.
 *    Defaults to true (on by default) — set below in makeContext.
 *  - `allowProjectArtifacts`: unchanged meaning. Still gates DELETION eligibility.
 *
 * providers/project.ts (owned by another agent) must change its discover()
 * early return from `if (!context.allowProjectArtifacts) return [];` to
 * `if (context.reportProjectArtifacts === false) return [];`, and keep using
 * `context.allowProjectArtifacts` everywhere it currently gates eligibility /
 * revalidate() so deletion stays opt-in.
 */
declare module "./types.js" {
  interface ScanContext {
    reportProjectArtifacts?: boolean;
  }
}

export function makeContext(config: ConfigFile, roots: string[] = [], cwd = processCwd(), env = processEnv, allowProjectArtifacts = false): ExecuteContext {
  const allRoots = [...new Set([cwd, ...config.roots, ...roots].map((root) => absolutePath(root, cwd)))];
  return { now: Date.now(), roots: allRoots, configRoots: config.roots, cwd, home: homedir(), env, policy: config.policy, allowProjectArtifacts: allowProjectArtifacts || config.allowProjectArtifacts === true, reportProjectArtifacts: true, dryRun: false, runDir: stateDir(env) };
}

/**
 * Same as makeContext, but first runs zero-config root discovery (common
 * development directory names under `home`, plus shallow git repos within
 * them — see ./roots.ts) and folds the result into `roots`, so a bare run
 * actually scans something. Async because discovery touches the filesystem,
 * so this is a separate export rather than a change to makeContext's own
 * signature: src/cli.ts (owned by another agent) calls `makeContext(...)`
 * synchronously at four call sites today and must keep compiling untouched.
 * For a bare run to pick up discovered roots, cli.ts's call sites need to
 * switch to `await makeContextWithDiscoveredRoots(...)`.
 */
export async function makeContextWithDiscoveredRoots(config: ConfigFile, roots: string[] = [], cwd = processCwd(), env = processEnv, allowProjectArtifacts = false): Promise<ExecuteContext> {
  const discovered = await discoverRoots({ home: homedir(), cwd, env }).catch(() => []);
  return makeContext(config, [...roots, ...discovered], cwd, env, allowProjectArtifacts);
}
