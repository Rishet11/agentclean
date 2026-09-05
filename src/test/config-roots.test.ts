import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig, saveConfig } from "../config/store.js";
import { makeContext } from "../core/context.js";
import { EXIT_OK } from "../core/errors.js";
import { formatBytes } from "../core/output.js";
import { defaultPolicy } from "../core/policy.js";
import type { ConfigFile } from "../core/types.js";
import { printNewlyRegisteredPools, runAuto, runConfig, type Options } from "../cli.js";

// Everything in this file that goes through `runConfig`/`runAuto` calls
// `loadConfig()`/`saveConfig()` with the default `process.env` (they accept
// no override), so this points XDG_CONFIG_HOME at a private temp directory
// for the lifetime of this file's process instead. Node's test runner puts
// each *.test.ts file in its own process (see git-worktrees.test.ts's
// identical reasoning for GIT_CONFIG_GLOBAL), so this can never leak into
// another test file or the real developer's ~/.config/agentclean/config.json.
const configHome = await mkdtemp(path.join(os.tmpdir(), "agentclean-cli-config-"));
process.env.XDG_CONFIG_HOME = configHome;

after(async () => {
  await rm(configHome, { recursive: true, force: true });
});

const baseOptions: Options = {
  json: false,
  dryRun: false,
  yes: false,
  strict: false,
  verbose: false,
  roots: [],
  projectArtifacts: false,
  forceUnlock: false,
};

// ---------------------------------------------------------------------------
// core/context.ts: policy.worktreeRoots is folded into context.roots
// ---------------------------------------------------------------------------

test("makeContext folds config.policy.worktreeRoots into context.roots alongside config.roots and cwd", () => {
  const config: ConfigFile = {
    version: 1,
    roots: ["/tmp/manually-added-root"],
    policy: { ...defaultPolicy, worktreeRoots: ["/tmp/derived-pool-root"] },
  };
  const context = makeContext(config, [], "/tmp/somewhere", {});
  assert.ok(context.roots.includes(path.resolve("/tmp/manually-added-root")), "config.roots still folded in");
  assert.ok(context.roots.includes(path.resolve("/tmp/derived-pool-root")), "policy.worktreeRoots now folded in too");
});

// ---------------------------------------------------------------------------
// config/store.ts: policy.worktreeRoots round-trips through save/load
// ---------------------------------------------------------------------------

test("saveConfig/loadConfig round-trip policy.worktreeRoots, normalized to absolute paths", async () => {
  const env = { XDG_CONFIG_HOME: await mkdtemp(path.join(os.tmpdir(), "agentclean-store-")) };
  try {
    const fresh = await loadConfig(env);
    assert.deepEqual(fresh.policy.worktreeRoots, [], "a brand new config starts with no worktree roots");

    fresh.policy.worktreeRoots = ["relative/pool", "/already/absolute/pool"];
    await saveConfig(fresh, env);

    const reloaded = await loadConfig(env);
    assert.deepEqual(reloaded.policy.worktreeRoots, [path.resolve("relative/pool"), "/already/absolute/pool"]);
  } finally {
    await rm(env.XDG_CONFIG_HOME, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cli.ts: `config root add|remove`
// ---------------------------------------------------------------------------

test("runConfig: add appends to config.roots, and is idempotent", async () => {
  const target = path.join(configHome, "project-a");

  const code = await runConfig(["config", "root", "add", target], baseOptions);
  assert.equal(code, EXIT_OK);
  const afterAdd = await loadConfig();
  assert.ok(afterAdd.roots.includes(path.resolve(target)));

  const countAfterFirstAdd = afterAdd.roots.length;
  await runConfig(["config", "root", "add", target], baseOptions);
  const afterSecondAdd = await loadConfig();
  assert.equal(afterSecondAdd.roots.length, countAfterFirstAdd, "adding the same root twice must not duplicate it");
});

test("runConfig: remove strips a path from both config.roots and policy.worktreeRoots -- undoing either kind of registration", async () => {
  const target = path.resolve(path.join(configHome, "project-b"));
  const config = await loadConfig();
  config.roots.push(target);
  config.policy.worktreeRoots.push(target); // as if this had been auto-registered from git evidence
  await saveConfig(config);

  const code = await runConfig(["config", "root", "remove", target], baseOptions);
  assert.equal(code, EXIT_OK);

  const reloaded = await loadConfig();
  assert.equal(reloaded.roots.includes(target), false, "removed from config.roots");
  assert.equal(reloaded.policy.worktreeRoots.includes(target), false, "removed from policy.worktreeRoots too");
});

test("runConfig: removing a path that was never registered says so, and does not rewrite the config", async () => {
  const target = path.join(configHome, "never-registered");
  const before = await loadConfig();

  const code = await runConfig(["config", "root", "remove", target], baseOptions);

  assert.equal(code, EXIT_OK);
  const afterAttempt = await loadConfig();
  assert.deepEqual(afterAttempt, before);
});

// ---------------------------------------------------------------------------
// cli.ts: `auto install` ordering (checks support and installs before ever
// touching config; ../platform/scheduler.ts is not owned here and is not
// mocked -- installScheduler really runs, and really throws on every
// platform but win32, which is exactly the case this bug needs proving on).
// ---------------------------------------------------------------------------

test(
  "runAuto install: a failing install (unsupported platform) leaves no config file behind as a side effect",
  { skip: process.platform === "win32" ? "installScheduler is expected to succeed on win32; this test only proves the failure path" : false },
  async () => {
    const isolatedConfigHome = await mkdtemp(path.join(os.tmpdir(), "agentclean-auto-install-"));
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = isolatedConfigHome;
    try {
      await assert.rejects(() => runAuto(["auto", "install"], baseOptions));
      const configFile = path.join(isolatedConfigHome, "agentclean", "config.json");
      await assert.rejects(
        () => readFile(configFile, "utf8"),
        /ENOENT/,
        "install failed, so no config file should exist -- confirms install runs, and fails, before saveConfig",
      );
    } finally {
      process.env.XDG_CONFIG_HOME = saved;
      await rm(isolatedConfigHome, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// cli.ts: printNewlyRegisteredPools -- the one-time disclosure message
// ---------------------------------------------------------------------------

type Sink = NodeJS.WritableStream & { text(): string };

function sink(): Sink {
  const chunks: string[] = [];
  return {
    write: ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as Sink["write"],
    text: () => chunks.join(""),
  } as Sink;
}

test("printNewlyRegisteredPools prints nothing when there is nothing new", () => {
  const output = sink();
  printNewlyRegisteredPools([], output);
  assert.equal(output.text(), "");
});

test("printNewlyRegisteredPools: plural wording, the byte total, and the undo command -- and never the word \"worktree\" in its own prose", () => {
  const output = sink();
  const bytes = 10 * 1024 ** 3;
  // Deliberately not named "worktrees": the directory name is real evidence
  // and may say anything; this test is about the tool's own prose choice of
  // "spare copy", so the fixture must not accidentally supply the word this
  // assertion is checking the code never adds on its own.
  printNewlyRegisteredPools([{ root: path.join(os.homedir(), ".ao", "data", "instances"), worktreeCount: 43, bytes }], output);
  const text = output.text();

  assert.match(text, /Added 1 folder from git's own records:/);
  assert.match(text, /43 spare copies,/);
  assert.match(text, new RegExp(formatBytes(bytes).replace(".", "\\.")));
  assert.match(text, /Undo: {2}agentclean config root remove <path>/);
  assert.equal(text.toLowerCase().includes("worktree"), false, "user-facing prose must say \"spare copy\", never \"worktree\"");
});

test("printNewlyRegisteredPools: singular wording for exactly one folder holding exactly one spare copy", () => {
  const output = sink();
  printNewlyRegisteredPools([{ root: "/pool", worktreeCount: 1, bytes: 100 }], output);
  const text = output.text();

  assert.match(text, /Added 1 folder from/);
  assert.equal(text.includes("folders"), false);
  assert.match(text, /1 spare copy,/);
  assert.equal(text.includes("spare copies"), false);
});
