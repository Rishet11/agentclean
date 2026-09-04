#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin, stdout, stderr } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { loadConfig, saveConfig } from "./config/store.js";
import { makeContext, makeContextWithDiscoveredRoots } from "./core/context.js";
import { EXIT_FATAL, EXIT_OK, EXIT_PARTIAL, EXIT_USAGE } from "./core/errors.js";
import { executePlan } from "./core/executor.js";
import { autoPlan } from "./core/auto.js";
import { createPlan, loadPlan, savePlan } from "./core/plan.js";
import { purgeExpired, purgeRun, quarantineRootDir, restoreRun } from "./core/quarantine.js";
import { displayPath, stateDir } from "./core/paths.js";
import { buildReport } from "./core/report.js";
import { runChecklist } from "./ui/checklist.js";
import { formatBytes, humanFailure, shortLabelForCandidate } from "./core/output.js";
import { printPlan, printProviders, printResult, printSummary } from "./core/output.js";
import { scanProviders } from "./core/scan.js";
import { latestManifest } from "./core/manifest.js";
import { createProgress } from "./ui/progress.js";
import { providerMap, providers } from "./providers/registry.js";
import { installScheduler, schedulerStatus, uninstallScheduler } from "./platform/scheduler.js";
import type { Plan, RunResult } from "./core/types.js";

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
  output.write(`agentclean — safe storage cleanup for AI coding tools

The short version:
  agentclean                    look around, see what could be freed
  agentclean clean               choose what to remove, one item at a time
  agentclean clean --dry-run     preview a real run without changing anything
  agentclean restore             put back anything still being held
  agentclean scan -v             full detail on everything found

Options you'll actually use:
  --root <path>         also look in this folder
  --dry-run              never change anything
  --yes, -y              skip the confirmation (only with --plan or auto --once)
  -v, --verbose          full detail instead of the short summary
  --json                  machine-readable output, for scripts

-v and --json work on every command below too.

Less common:
  agentclean providers                 what agentclean can see on this machine
  agentclean explain <candidate-id>    why one item was flagged (needs --plan)
  agentclean doctor                    diagnostics for a bug report
  agentclean config root add <path>    remember a folder for every future scan
  agentclean purge                     free held space now instead of waiting
  agentclean auto install --interval <weekly|...>   set up scheduled cleanup
  agentclean auto uninstall | status   manage scheduled cleanup
  --out <file>            save a scan to a plan file
  --plan <file>            act on a saved plan instead of scanning fresh
  --category <name>       limit to one kind: worktrees, ai-history, ai-caches, package-caches
  --provider <name>        limit to one tool
  --project-artifacts      also scan for node_modules, virtualenvs, and build output
  --strict                  treat any skip or decline as a failure (exit code)
  --force-unlock            reclaim a lock left by a crashed run on another machine
  --version                 print the version number
`);
}

function readVersion(): string {
  try {
    return (require("../package.json") as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function askConfirmation(count: number, bytes?: number): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("interactive confirmation required; use --plan <file> --yes for automation");
  const reader = createInterface({ input: stdin, output: stdout });
  const size = bytes === undefined ? "" : ` (${formatBytes(bytes)})`;
  try { return (await reader.question(`Remove ${count} item(s)${size}? This cannot be undone. [y/N] `)).trim().toLowerCase() === "y"; } finally { reader.close(); }
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
    else printResult(result, selected, stdout);
    return EXIT_OK;
  }
  const guard = requiresExplicitPlan({ autoOnly, yes: options.yes, plan: options.plan, category: options.category, provider: options.provider, isTty: Boolean(stdin.isTTY && stdout.isTTY) });
  if (!guard.ok) throw new UsageError(guard.message);
  let toExecute = selected;
  if (!autoOnly && !options.yes) {
    // A single all-or-nothing y/N over everything eligible is not a decision a
    // person can actually make. Offer the list and let them choose per item.
    const choice = await runChecklist(buildReport(selected), { stdin, stdout });
    if (choice.aborted) {
      stdout.write("Nothing removed.\n");
      return EXIT_OK;
    }
    const chosen = selected.candidates.filter((candidate) => choice.selectedIds.has(candidate.id));
    if (chosen.length === 0) {
      stdout.write("Nothing selected, nothing removed.\n");
      return EXIT_OK;
    }
    toExecute = createPlan(chosen, selected.roots, context.now, {
      policyHash: selected.policyHash,
      platform: selected.platform,
      home: selected.home,
      providerIds: selected.providerIds,
    });
    const total = chosen.reduce((sum, candidate) => sum + candidate.bytes, 0);
    if (!(await askConfirmation(chosen.length, total))) {
      stdout.write("Nothing removed.\n");
      return EXIT_OK;
    }
  }
  const result = await executeWithProgress(toExecute, map, context, { dryRun: false, strict: options.strict, forceUnlock: options.forceUnlock }, options.json ? undefined : stdout);
  if (options.json) await writeOutput({ plan: selected, result }, options);
  else printResult(result, toExecute, stdout);
  return cleanExitCode(result);
}

/**
 * `executePlan` (core/executor.ts) has no progress callback, so this drives
 * the terminal from the outside instead: `latestManifest` reads the exact
 * run-*.json that `executePlan`'s own `persist()` writes to disk after each
 * candidate, filtered to this plan's hash so a stale manifest from an earlier
 * run is never mistaken for this one. The candidate about to run (not yet in
 * the manifest) comes straight from `toExecute.candidates[completedCount]` -
 * the executor processes candidates strictly in that order - so the line
 * keeps moving even mid-way through one slow command (e.g. `uv cache prune`
 * running for two minutes with nothing yet written to the manifest).
 */
async function executeWithProgress(toExecute: Plan, map: ReturnType<typeof providerMap>, context: Awaited<ReturnType<typeof makeContextWithDiscoveredRoots>>, executeOptions: { dryRun: boolean; strict: boolean; forceUnlock?: boolean }, progressOutput: NodeJS.WritableStream & { isTTY?: boolean; columns?: number } | undefined): Promise<RunResult> {
  const progress = progressOutput ? createProgress(progressOutput) : undefined;
  let polling: NodeJS.Timeout | undefined;
  if (progress) {
    polling = setInterval(() => {
      void latestManifest(context.env).then((manifest) => {
        const current = manifest?.planHash === toExecute.hash ? manifest : undefined;
        const completed = current?.results.length ?? 0;
        const freed = current?.deletedBytes ?? 0;
        const candidate = toExecute.candidates[completed];
        progress.update(candidate ? shortLabelForCandidate(candidate) : "finishing up", freed);
      }).catch(() => undefined);
    }, 100);
  }
  try {
    return await executePlan(toExecute, map, { ...context, dryRun: false }, executeOptions);
  } finally {
    if (polling) clearInterval(polling);
    progress?.clear();
  }
}

/**
 * Declined-by-design candidates (e.g. younger-than-30-days) are never a
 * failure. Real deviations (skipped) or outright failures are. --strict
 * additionally turns a declined candidate into a failure (RunResult.strictViolation).
 */
export function cleanExitCode(result: RunResult): number {
  return result.failedBytes > 0 || result.skippedBytes > 0 || result.strictViolation ? EXIT_PARTIAL : EXIT_OK;
}

/**
 * Undo. Only ever holds what had no other way back, so this is short by design:
 * caches and build output were never moved here in the first place.
 */
async function runRestore(positionals: string[], options: Options): Promise<number> {
  const target = positionals[1] || "last";
  const held = await readdir(quarantineRootDir(stateDir(process.env))).catch(() => [] as string[]);
  if (held.length === 0) {
    stdout.write("\n  Nothing is being held.\n  Only things with no other way back are kept, and none are right now.\n\n");
    return EXIT_OK;
  }
  const outcome = await restoreRun(stateDir(process.env), target === "last" ? "last" : target);
  if (options.json) { await writeOutput(outcome, options); return EXIT_OK; }
  stdout.write("\n");
  if (outcome.restored.length > 0) {
    stdout.write(`  Put back ${outcome.restored.length} item(s)\n`);
    for (const entry of outcome.restored.slice(0, 8)) stdout.write(`    ${displayPath(entry.originalPath)}\n`);
  }
  if (outcome.conflicts.length > 0) {
    stdout.write(`\n  ${outcome.conflicts.length} left where they are, because something already exists at the original path:\n`);
    for (const entry of outcome.conflicts.slice(0, 5)) stdout.write(`    ${displayPath(entry.originalPath)}\n`);
  }
  if (outcome.missing.length > 0) stdout.write(`\n  ${outcome.missing.length} item(s) were already gone from the holding area.\n`);
  if (outcome.restored.length === 0 && outcome.conflicts.length === 0) stdout.write("  Nothing to put back.\n");
  stdout.write("\n");
  return EXIT_OK;
}

/** Make held space real, either on schedule or because the user wants it now. */
async function runPurge(positionals: string[], options: Options): Promise<number> {
  const root = stateDir(process.env);
  const outcome = positionals[1] && positionals[1] !== "--all"
    ? await purgeRun(root, positionals[1])
    : await purgeExpired(root, Date.now());
  if (options.json) { await writeOutput(outcome, options); return EXIT_OK; }
  stdout.write(outcome.removedBytes > 0
    ? `\n  Freed ${formatBytes(outcome.removedBytes)} that was being held.\n  It is gone for good now.\n\n`
    : "\n  Nothing was ready to purge.\n  Held items are kept for 7 days before their space is actually freed.\n\n");
  return EXIT_OK;
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
  if (command === "restore") return await runRestore(positionals, options);
  if (command === "purge") return await runPurge(positionals, options);
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

/**
 * `locks.ts` (not owned here) throws two exact message shapes for a held
 * lock, matched here by their distinguishing substrings since editing that
 * file is out of scope. The two are not interchangeable: `--force-unlock`
 * only bypasses a *foreign-host* lock (see `acquireLock`'s `foreignHost`
 * branch) - a genuinely active same-host run has no override, so the two
 * cases get different, verified-against-that-code advice. Anything else
 * falls through to `humanFailure` for the same OS-error translation
 * `printResult` uses, so a raw ENOSPC/EACCES/ENOENT that escapes to the top
 * level still reads as a sentence instead of a stack-trace-shaped string.
 */
function friendlyTopLevelError(message: string): string {
  if (message.includes("use --force-unlock to override")) {
    return "Another machine's agentclean run holds the lock here. If you're sure it isn't really running, retry with --force-unlock.";
  }
  if (message.includes("another cleanup run is active")) {
    return "Another agentclean cleanup is already running. Wait for it to finish, then try again.";
  }
  return humanFailure(message);
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
    stderr.write(`${error instanceof Error ? friendlyTopLevelError(error.message) : "unexpected error"}\n`);
    process.exitCode = EXIT_FATAL;
  });
}
