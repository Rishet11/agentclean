#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin, stdout, stderr } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { loadConfig, saveConfig } from "./config/store.js";
import { makeContext, makeContextWithDiscoveredRoots } from "./core/context.js";
import { EXIT_FATAL, EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from "./core/errors.js";
import { executePlan } from "./core/executor.js";
import { autoPlan } from "./core/auto.js";
import { loadPlan, savePlan } from "./core/plan.js";
import { printPlan, printProviders, printResult, printSummary } from "./core/output.js";
import { scanProviders } from "./core/scan.js";
import { providerMap, providers } from "./providers/registry.js";
import { installScheduler, schedulerStatus, uninstallScheduler } from "./platform/scheduler.js";
import type { RunResult } from "./core/types.js";

const require = createRequire(import.meta.url);

class UsageError extends Error {
  constructor(message: string, readonly showUsage = false) {
    super(message);
  }
}

interface Options {
  json: boolean;
  dryRun: boolean;
  yes: boolean;
  strict: boolean;
  verbose: boolean;
  out?: string;
  plan?: string;
  category?: string;
  provider?: string;
  roots: string[];
  interval?: string;
  projectArtifacts: boolean;
  forceUnlock: boolean;
}

function parseOptions(args: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = [];
  const options: Options = { json: false, dryRun: false, yes: false, strict: false, verbose: false, roots: [], projectArtifacts: false, forceUnlock: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--project-artifacts") options.projectArtifacts = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg === "--force-unlock") options.forceUnlock = true;
    else if (arg === "--out" || arg === "--plan" || arg === "--category" || arg === "--provider" || arg === "--root" || arg === "--interval") {
      const value = args[++index];
      if (!value) throw new UsageError(`${arg} requires a value`, true);
      if (arg === "--out") options.out = value;
      else if (arg === "--plan") options.plan = value;
      else if (arg === "--category") options.category = value;
      else if (arg === "--provider") options.provider = value;
      else if (arg === "--root") options.roots.push(value);
      else options.interval = value;
    } else if (arg === "--help" || arg === "-h") positionals.push("help");
    else if (arg === "--version") positionals.push("version");
    else if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`, true);
    else positionals.push(arg);
  }
  return { positionals, options };
}

function usage(output: NodeJS.WritableStream = stdout): void {
  output.write(`agentclean — safe storage cleanup for AI coding tools\n\nUsage:\n  agentclean [scan] [options]\n  agentclean clean [options]\n  agentclean auto --once [options]\n  agentclean providers [--json]\n  agentclean explain <candidate-id> --plan <plan.json>\n  agentclean doctor\n  agentclean config root add <path>\n  agentclean auto install --interval weekly\n  agentclean auto uninstall\n  agentclean auto status\n\nOptions:\n  --json              Machine-readable output\n  --out <file>        Save a scan plan\n  --plan <file>       Execute or inspect an explicit plan\n  --dry-run           Never mutate anything\n  --yes               Skip confirmation (requires --plan or auto --once)\n  --strict            Fail if any candidate is declined, skipped, or fails\n  --category <name>   worktrees, ai-history, ai-caches, package-caches\n  --provider <name>   Limit to one provider\n  --root <path>       Add an explicit repository root
  --project-artifacts Scan configured roots for node_modules, venvs, and build output
  --force-unlock      Reclaim a lock held by a process on another host
  --version           Print the version number
`);
}

function readVersion(): string {
  try {
    return (require("../package.json") as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function askConfirmation(count: number): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("interactive confirmation required; use --plan <file> --yes for automation");
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(`Delete ${count} approved item(s)? This cannot be undone. [y/N] `)).trim().toLowerCase() === "y"; } finally { reader.close(); }
}

/**
 * `--yes` means "I have already decided". That is only true when the set being
 * acted on is one a human reviewed: an explicit --plan file, or a deterministic
 * policy selector (auto --once). --category/--provider are filters on a fresh
 * scan, not a reviewed selection, and must never make --yes legal on their own.
 */
export function requiresExplicitPlan(input: { autoOnly: boolean; yes: boolean; plan?: string; category?: string; provider?: string; isTty: boolean }): { ok: true } | { ok: false; message: string } {
  if (input.autoOnly || input.plan) return { ok: true };
  const wayForward = "choose interactively (omit --yes), pass --plan <file> --yes for a reviewed plan, or run `agentclean scan --out plan.json` first.";
  if (input.yes) return { ok: false, message: `refusing --yes against an unreviewed scan: ${wayForward}` };
  if (!input.isTty) return { ok: false, message: `refusing non-interactive cleanup with no way to confirm: ${wayForward}` };
  return { ok: true };
}

async function writeOutput(value: unknown, options: Options, output: NodeJS.WritableStream = stdout): Promise<void> {
  if (!options.json) return;
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runScan(options: Options, autoOnly = false): Promise<number> {
  const config = await loadConfig();
  const context = await makeContextWithDiscoveredRoots(config, options.roots, process.cwd(), process.env, options.projectArtifacts || Boolean(options.category && ["project-dependencies", "project-environments", "build-artifacts"].includes(options.category)));
  const map = providerMap();
  const plan = await scanProviders([...map.values()], context, { category: options.category, provider: options.provider });
  const filtered = autoOnly ? autoPlan(plan, config.policy, context.now) : plan;
  if (options.out) await savePlan(filtered, path.resolve(options.out));
  if (options.json) await writeOutput(filtered, options);
  else if (options.verbose) printPlan(filtered, stdout);
  else printSummary(filtered, stdout);
  return EXIT_OK;
}

async function runClean(options: Options, autoOnly = false): Promise<number> {
  const config = await loadConfig();
  const context = await makeContextWithDiscoveredRoots(config, options.roots, process.cwd(), process.env, options.projectArtifacts || Boolean(options.category && ["project-dependencies", "project-environments", "build-artifacts"].includes(options.category)));
  const map = providerMap();
  if (autoOnly && options.plan) throw new UsageError("auto mode always scans a fresh plan; --plan is not allowed");
  const plan = options.plan ? await loadPlan(path.resolve(options.plan)) : await scanProviders([...map.values()], context, { category: options.category, provider: options.provider });
  const selected = autoOnly ? autoPlan(plan, config.policy, context.now) : plan;
  if (!options.json) (options.verbose ? printPlan : printSummary)(selected, stdout);
  const eligible = selected.candidates.filter((candidate) => candidate.eligible && candidate.blockers.length === 0 && candidate.action !== "skip");
  if (options.dryRun) {
    const result = await executePlan(selected, map, { ...context, dryRun: true }, { dryRun: true, strict: options.strict });
    if (options.json) await writeOutput({ plan: selected, result }, options);
    else printResult(result, stdout);
    return EXIT_OK;
  }
  const guard = requiresExplicitPlan({ autoOnly, yes: options.yes, plan: options.plan, category: options.category, provider: options.provider, isTty: Boolean(stdin.isTTY && stdout.isTTY) });
  if (!guard.ok) throw new UsageError(guard.message);
  if (!autoOnly && !options.yes) {
    if (!(await askConfirmation(eligible.length))) return EXIT_OK;
  }
  const result = await executePlan(selected, map, { ...context, dryRun: false }, { dryRun: false, strict: options.strict, forceUnlock: options.forceUnlock });
  if (options.json) await writeOutput({ plan: selected, result }, options);
  else printResult(result, stdout);
  return cleanExitCode(result);
}

/**
 * Declined-by-design candidates (e.g. younger-than-30-days) are never a
 * failure. Real deviations (skipped) or outright failures are. --strict
 * additionally turns a declined candidate into a failure (RunResult.strictViolation).
 */
export function cleanExitCode(result: RunResult): number {
  return result.failedBytes > 0 || result.skippedBytes > 0 || result.strictViolation ? EXIT_PARTIAL : EXIT_OK;
}

async function runProviders(options: Options): Promise<number> {
  const config = await loadConfig();
  const context = makeContext(config);
  const detections = await Promise.all(providers().map((provider) => provider.detect(context)));
  if (options.json) await writeOutput(detections, options);
  else printProviders(detections, stdout);
  return EXIT_OK;
}

async function runExplain(candidateID: string, options: Options): Promise<number> {
  if (!options.plan) throw new UsageError("explain requires --plan <file>");
  const plan = await loadPlan(path.resolve(options.plan));
  const candidate = plan.candidates.find((item) => item.id === candidateID);
  if (!candidate) throw new Error(`candidate not found: ${candidateID}`);
  const provider = providerMap().get(candidate.provider);
  const explanation = provider?.explain(candidate) || "provider unavailable";
  if (options.json) await writeOutput({ candidate, explanation }, options);
  else stdout.write(`${candidate.id} [${candidate.provider}]: ${explanation}\n`);
  return EXIT_OK;
}

async function runDoctor(options: Options): Promise<number> {
  const config = await loadConfig();
  const context = makeContext(config);
  const detections = await Promise.all(providers().map((provider) => provider.detect(context)));
  const result = { platform: process.platform, node: process.version, cwd: context.cwd, roots: context.roots, configRoots: config.roots, providers: detections };
  if (options.json) await writeOutput(result, options);
  else {
    stdout.write(`platform: ${result.platform}\nnode: ${result.node}\ncwd: ${result.cwd}\nroots: ${result.roots.join(", ") || "(none)"}\n`);
    printProviders(detections, stdout);
  }
  return EXIT_OK;
}

async function runConfig(positionals: string[], options: Options): Promise<number> {
  if (positionals[0] !== "config" || positionals[1] !== "root" || positionals[2] !== "add" || !positionals[3]) throw new UsageError("usage: agentclean config root add <path>");
  const config = await loadConfig();
  const root = path.resolve(positionals[3]);
  if (!config.roots.includes(root)) config.roots.push(root);
  await saveConfig(config);
  stdout.write(`Added root: ${root}\n`);
  return EXIT_OK;
}

async function runAuto(positionals: string[], options: Options): Promise<number> {
  const action = positionals[1];
  if (action === "--once") return await runClean(options, true);
  if (action === "install") {
    const config = await loadConfig();
    await saveConfig(config, process.env);
    await installScheduler(process.execPath, path.resolve(process.argv[1]), options.interval || "weekly");
    stdout.write(`Installed ${options.interval || "weekly"} automatic cleanup.\n`);
    return EXIT_OK;
  }
  if (action === "uninstall") { await uninstallScheduler(); stdout.write("Automatic cleanup removed.\n"); return EXIT_OK; }
  if (action === "status") {
    const status = await schedulerStatus();
    if (options.json) await writeOutput(status, options);
    else stdout.write(`installed: ${status.installed}\n${status.details}\n`);
    return EXIT_OK;
  }
  throw new UsageError("usage: agentclean auto --once | install | uninstall | status");
}

async function main(): Promise<number> {
  const { positionals, options } = parseOptions(process.argv.slice(2));
  if (positionals.includes("help")) { usage(); return EXIT_OK; }
  if (positionals.includes("version")) { stdout.write(`${readVersion()}\n`); return EXIT_OK; }
  if (positionals.length === 0) return await runScan(options);
  const command = positionals[0];
  if (command === "scan") return await runScan(options);
  if (command === "clean") return await runClean(options);
  if (command === "auto") return await runAuto(positionals, options);
  if (command === "providers") return await runProviders(options);
  if (command === "explain") return await runExplain(positionals[1] || "", options);
  if (command === "doctor") return await runDoctor(options);
  if (command === "config") return await runConfig(positionals, options);
  throw new UsageError(`unknown command: ${command}`, true);
}

function computeIsEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  // A global/linked install invokes this script through a bin symlink, so
  // argv[1] and import.meta.url must both be resolved to their real path
  // before comparing, or the CLI silently never runs.
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isEntryPoint = computeIsEntryPoint();
if (isEntryPoint) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      if (error.showUsage) usage(stderr);
      process.exitCode = EXIT_USAGE;
      return;
    }
    stderr.write(`${error instanceof Error ? error.message : "unexpected error"}\n`);
    process.exitCode = EXIT_FATAL;
  });
}
