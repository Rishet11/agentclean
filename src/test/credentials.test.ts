import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProvider, clineProvider, codexProvider, cursorProvider } from "../providers/ai.js";
import { isWithin } from "../core/paths.js";
import type { ExecuteContext } from "../core/types.js";

/**
 * The safety test: credentials, live application state, and installed
 * extensions must never be candidate targets, even when they are old enough
 * to pass every age gate. This is the one place that currently only existed
 * against the synthetic DiagnosticProvider (which never discovered anything
 * at all) — here it runs against the real filesystem-backed providers.
 */

const VERY_OLD = new Date(Date.now() - 3650 * 86_400_000);

function context(home: string, env: NodeJS.ProcessEnv = {}): ExecuteContext {
  return {
    now: Date.now(),
    roots: [home],
    configRoots: [],
    cwd: home,
    home,
    env,
    policy: { version: 1, safeCacheAgeDays: 30, historyAgeDays: 90, worktreeInactiveDays: 30, autoCategories: [], autoProviders: [], worktreeRoots: [] },
    dryRun: false,
    runDir: home,
  };
}

async function makeProtectedHome(): Promise<string> {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-credentials-")));

  const files = [
    [".claude", ".credentials.json"],
    [".claude", "settings.json"],
    [".claude", "plugins", "x"],
    [".claude", "file-history", "x"],
    [".claude", "backups", "x"],
    [".codex", "auth.json"],
    [".codex", "plugins", "x"],
    [".codex", "state_5.sqlite"],
    [".codex", "memories_1.sqlite"],
    [".cursor", "extensions", "x"],
  ];

  for (const parts of files) {
    const target = path.join(home, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "protected content");
    await utimes(target, VERY_OLD, VERY_OLD);
    await utimes(path.dirname(target), VERY_OLD, VERY_OLD);
  }
  // Age the provider roots themselves too, so nothing is excluded merely for
  // looking "too young".
  for (const dir of [".claude", ".codex", ".cursor"]) {
    await utimes(path.join(home, dir), VERY_OLD, VERY_OLD).catch(() => undefined);
  }

  return home;
}

const protectedSubtrees = (home: string): string[] => [
  path.join(home, ".claude", ".credentials.json"),
  path.join(home, ".claude", "settings.json"),
  path.join(home, ".claude", "plugins"),
  path.join(home, ".claude", "file-history"),
  path.join(home, ".claude", "backups"),
  path.join(home, ".codex", "auth.json"),
  path.join(home, ".codex", "plugins"),
  path.join(home, ".codex", "state_5.sqlite"),
  path.join(home, ".codex", "memories_1.sqlite"),
  path.join(home, ".cursor", "extensions"),
];

test("SAFETY: real claude/codex/cursor providers never target credentials, live state, or installed extensions", async () => {
  const home = await makeProtectedHome();
  const ctx = context(home);
  const subtrees = protectedSubtrees(home);

  const candidates = [...(await claudeProvider().discover(ctx)), ...(await codexProvider().discover(ctx)), ...(await cursorProvider().discover(ctx))];

  for (const candidate of candidates) {
    assert.equal(candidate.target.kind, "path");
    if (candidate.target.kind !== "path") continue;
    for (const protectedPath of subtrees) {
      assert.equal(
        isWithin(protectedPath, candidate.target.path) || isWithin(candidate.target.path, protectedPath) || candidate.target.path === protectedPath,
        false,
        `candidate ${candidate.target.path} overlaps protected path ${protectedPath}`,
      );
    }
  }
});

test("SAFETY: codex sqlite allowlist never surfaces state_/memories_/goals_/queue_ files even when very old", async () => {
  const home = await makeProtectedHome();
  // codexProvider's root is ~/.codex by default (no CODEX_HOME set here).
  const candidates = await codexProvider().discover(context(home));
  const targets = candidates.map((c) => (c.target.kind === "path" ? c.target.path : ""));
  assert.ok(!targets.some((t) => path.basename(t) === "state_5.sqlite"));
  assert.ok(!targets.some((t) => path.basename(t) === "memories_1.sqlite"));
  assert.ok(!targets.some((t) => t.includes(`${path.sep}plugins${path.sep}`) || t.endsWith(`${path.sep}plugins`)));
});

test("SAFETY: cursor never scans ~/.cursor at all (its root is the platform app-support directory)", async () => {
  const home = await makeProtectedHome();
  const candidates = await cursorProvider().discover(context(home));
  for (const candidate of candidates) {
    if (candidate.target.kind !== "path") continue;
    assert.ok(!candidate.target.path.startsWith(path.join(home, ".cursor")));
  }
});

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("SAFETY: cline never surfaces settings/cline_mcp_settings.json (live MCP config) even though it sits next to real task history", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agentclean-credentials-cline-")));
  const root = path.join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  await mkdir(path.join(root, "tasks", "task-1"), { recursive: true });
  await writeFile(path.join(root, "tasks", "task-1", "api_conversation_history.json"), "x".repeat(40));
  await mkdir(path.join(root, "checkpoints", "task-1"), { recursive: true });
  await writeFile(path.join(root, "checkpoints", "task-1", "shadow-git-data"), "x".repeat(30));
  await mkdir(path.join(root, "settings"), { recursive: true });
  await writeFile(path.join(root, "settings", "cline_mcp_settings.json"), "live mcp config, never a candidate");
  await utimes(path.join(root, "settings", "cline_mcp_settings.json"), VERY_OLD, VERY_OLD);

  const candidates = await withPlatform("darwin", () => clineProvider().discover(context(home)));
  assert.ok(candidates.length > 0, "expected the real task history to still surface as a report-only candidate");
  for (const candidate of candidates) {
    assert.equal(candidate.target.kind, "path");
    if (candidate.target.kind !== "path") continue;
    assert.ok(!candidate.target.path.includes(`${path.sep}settings${path.sep}`) && !candidate.target.path.endsWith("settings"));
  }
});
