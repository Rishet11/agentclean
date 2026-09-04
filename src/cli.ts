#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { loadConfig, saveConfig } from "./config/store.js";
import { makeContext } from "./core/context.js";
import { EXIT_FATAL, EXIT_OK, EXIT_PARTIAL } from "./core/errors.js";
import { executePlan } from "./core/executor.js";
import { autoPlan } from "./core/auto.js";
import { loadPlan, savePlan } from "./core/plan.js";
import { printPlan, printProviders, printResult } from "./core/output.js";
import { scanProviders } from "./core/scan.js";
import { providerMap, providers } from "./providers/registry.js";
import { installScheduler, schedulerStatus, uninstallScheduler } from "./platform/scheduler.js";

interface Options {
  json: boolean;
  dryRun: boolean;
  yes: boolean;
  strict: boolean;
  out?: string;
  plan?: string;
  category?: string;
  provider?: string;
  roots: string[];
  interval?: string;
  projectArtifacts: boolean;
}

function parseOptions(args: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = [];
  const options: Options = { json: false, dryRun: false, yes: false, strict: false, roots: [], projectArtifacts: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--project-artifacts") options.projectArtifacts = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--out" || arg === "--plan" || arg === "--category" || arg === "--provider" || arg === "--root" || arg === "--interval") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--out") options.out = value;
      else if (arg === "--plan") options.plan = value;
      else if (arg === "--category") options.category = value;
      else if (arg === "--provider") options.provider = value;
      else if (arg === "--root") options.roots.push(value);
      else options.interval = value;
    } else if (arg === "--help" || arg === "-h") positionals.push("help");
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positionals.push(arg);
  }
  return { positionals, options };
}

function usage(output: NodeJS.WritableStream = stdout): void {
  output.write(`agentclean — safe storage cleanup for AI coding tools\n\nUsage:\n  agentclean [scan] [options]\n  agentclean clean [options]\n  agentclean auto --once [options]\n  agentclean providers [--json]\n  agentclean explain <candidate-id> --plan <plan.json>\n  agentclean doctor\n  agentclean config root add <path>\n  agentclean auto install --interval weekly\n  agentclean auto uninstall\n  agentclean auto status\n\nOptions:\n  --json              Machine-readable output\n  --out <file>        Save a scan plan\n  --plan <file>       Execute or inspect an explicit plan\n  --dry-run           Never mutate anything\n  --yes               Skip confirmation (requires --plan for non-interactive use)\n  --strict            Fail if any candidate is skipped or fails\n  --category <name>   worktrees, ai-history, ai-caches, package-caches\n  --provider <name>   Limit to one provider\n  --root <path>       Add an explicit repository root
  --project-artifacts Scan configured roots for node_modules, venvs, and build output
`);
}

async function askConfirmation(count: number): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("interactive confirmation required; use --plan <file> --yes for automation");
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(`Delete ${count} approved item(s)? This cannot be undone. [y/N] `)).trim().toLowerCase() === "y"; } finally { reader.close(); }
}

async function writeOutput(value: unknown, options: Options, output: NodeJS.WritableStream = stdout): Promise<void> {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runScan(options: Options, autoOnly = false): Promise<number> {
  const config = await loadConfig();
  const context = makeContext(config, options.roots, process.cwd(), process.env, options.projectArtifacts || Boolean(options.category && ["project-dependencies", "project-environments", "build-artifacts"].includes(options.category)));
  const map = providerMap();
  const plan = await scanProviders([...map.values()], context, { category: options.category, provider: options.provider });
  const filtered = autoOnly ? autoPlan(plan, config.policy, context.now) : plan;
  if (options.out) await savePlan(filtered, path.resolve(options.out));
  if (options.json) await writeOutput(filtered, options);
  else printPlan(filtered, stdout);
  return EXIT_OK;
}

async function runClean(options: Options, autoOnly = false): Promise<number> {
  const config = await loadConfig();
  const context = makeContext(config, options.roots, process.cwd(), process.env, options.projectArtifacts || Boolean(options.category && ["project-dependencies", "project-environments", "build-artifacts"].includes(options.category)));
  const map = providerMap();
  if (autoOnly && options.plan) throw new Error("auto mode always scans a fresh plan; --plan is not allowed");
  const plan = options.plan ? await loadPlan(path.resolve(options.plan)) : await scanProviders([...map.values()], context, { category: options.category, provider: options.provider });
  const selected = autoOnly ? autoPlan(plan, config.policy, context.now) : plan;
  if (!options.json) printPlan(selected, stdout);
  const eligible = selected.candidates.filter((candidate) => candidate.eligible && candidate.blockers.length === 0 && candidate.action !== "skip");
  if (options.dryRun) {
    const result = await executePlan(selected, map, { ...context, dryRun: true }, { dryRun: true, strict: options.strict });
    if (options.json) await writeOutput({ plan: selected, result }, options);
    else printResult(result, stdout);
    return EXIT_OK;
  }
  if (!autoOnly && !options.yes) {
    if (!(await askConfirmation(eligible.length))) return EXIT_OK;
  } else if (!autoOnly && !options.plan && (!stdin.isTTY || !stdout.isTTY)) {
    throw new Error("non-interactive cleanup requires --plan <file> --yes");
  }
  const result = await executePlan(selected, map, { ...context, dryRun: false }, { dryRun: false, strict: options.strict });
  if (options.json) await writeOutput({ plan: selected, result }, options);
  else printResult(result, stdout);
  return result.failedBytes > 0 || result.skippedBytes > 0 ? EXIT_PARTIAL : EXIT_OK;
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
  if (!options.plan) throw new Error("explain requires --plan <file>");
  const plan = await loadPlan(path.resolve(options.plan));
  const candidate = plan.candidates.find((item) => item.id === candidateID);
  if (!candidate) throw new Error(`candidate not found: ${candidateID}`);
  const provider = providerMap().get(candidate.provider);
  const explanation = provider?.explain(candidate) || "provider unavailable";
  await writeOutput({ candidate, explanation }, options);
  return EXIT_OK;
}

async function runDoctor(options: Options): Promise<number> {
  const config = await loadConfig();
  const context = makeContext(config);
  const detections = await Promise.all(providers().map((provider) => provider.detect(context)));
  const result = { platform: process.platform, node: process.version, cwd: context.cwd, roots: context.roots, configRoots: config.roots, providers: detections };
  await writeOutput(result, options);
  return EXIT_OK;
}

async function runConfig(positionals: string[], options: Options): Promise<number> {
  if (positionals[0] !== "config" || positionals[1] !== "root" || positionals[2] !== "add" || !positionals[3]) throw new Error("usage: agentclean config root add <path>");
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
  if (action === "status") { const status = await schedulerStatus(); await writeOutput(status, options); return EXIT_OK; }
  throw new Error("usage: agentclean auto --once | install | uninstall | status");
}

async function main(): Promise<number> {
  const { positionals, options } = parseOptions(process.argv.slice(2));
  if (positionals.includes("help")) { usage(); return EXIT_OK; }
  if (positionals.length === 0) return await runScan(options);
  const command = positionals[0];
  if (command === "scan") return await runScan(options);
  if (command === "clean") return await runClean(options);
  if (command === "auto") return await runAuto(positionals, options);
  if (command === "providers") return await runProviders(options);
  if (command === "explain") return await runExplain(positionals[1] || "", options);
  if (command === "doctor") return await runDoctor(options);
  if (command === "config") return await runConfig(positionals, options);
  throw new Error(`unknown command: ${command}`);
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "unexpected error"}\n`); process.exitCode = EXIT_FATAL; });
