import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { antigravityProvider, claudeProvider, clineProvider, codexProvider, cursorProvider, geminiProvider, opencodeProvider } from "../providers/ai.js";
import type { Candidate, ExecuteContext } from "../core/types.js";

const HISTORY_BLOCKER = "history-requires-explicit-opt-in";
const OLD = new Date(Date.now() - 60 * 86_400_000);

async function tmpHome(prefix: string): Promise<string> {
  // realpath: on macOS os.tmpdir() is under /var, itself a symlink to /private/var.
  // Several guards here (isWithin/samePath after safeRealPath) reject the
  // uncanonicalized form, so an un-realpath'd fake home silently finds nothing.
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

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

async function age(target: string): Promise<void> {
  await utimes(target, OLD, OLD);
}

function targetPath(candidate: Candidate): string {
  return candidate.target.kind === "path" ? candidate.target.path : "";
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

async function makeCodexHome(): Promise<string> {
  const home = await tmpHome("agentclean-codex-");
  const codex = path.join(home, ".codex");
  await mkdir(path.join(codex, ".tmp", "git-0IfcxY"), { recursive: true });
  await writeFile(path.join(codex, ".tmp", "git-0IfcxY", "data"), "x".repeat(10));
  await mkdir(path.join(codex, "cache", "entry"), { recursive: true });
  await writeFile(path.join(codex, "cache", "entry", "data"), "x".repeat(10));
  await mkdir(path.join(codex, "shell_snapshots", "entry"), { recursive: true });
  await writeFile(path.join(codex, "shell_snapshots", "entry", "data"), "x".repeat(10));
  await mkdir(path.join(codex, "sessions", "2026", "01", "01"), { recursive: true });
  await writeFile(path.join(codex, "sessions", "2026", "01", "01", "rollout-x.jsonl"), "x".repeat(500));
  await mkdir(path.join(codex, "plugins", "some-plugin"), { recursive: true });
  await writeFile(path.join(codex, "plugins", "some-plugin", "bin"), "installed software");
  await writeFile(path.join(codex, "state_5.sqlite"), "live state");
  await writeFile(path.join(codex, "memories_1.sqlite"), "live state");
  await writeFile(path.join(codex, "goals_3.sqlite"), "live state");
  await writeFile(path.join(codex, "queue_7.sqlite"), "live state");
  await writeFile(path.join(codex, "logs_2.sqlite"), "x".repeat(100));
  await writeFile(path.join(codex, "logs_2.sqlite-wal"), "x".repeat(50));
  await writeFile(path.join(codex, "logs_2.sqlite-shm"), "x".repeat(20));
  await writeFile(path.join(codex, "thread_history_1.sqlite"), "x".repeat(80));
  for (const rel of [".tmp/git-0IfcxY", "cache/entry", "shell_snapshots/entry"]) {
    await age(path.join(codex, ...rel.split("/")));
  }
  return home;
}

test("codex: scratch/cache directories are eligible candidates", async () => {
  const home = await makeCodexHome();
  const candidates = await codexProvider().discover(context(home));
  const caches = candidates.filter((c) => c.category === "ai-caches");
  const names = new Set(caches.map((c) => path.basename(targetPath(c))));
  assert.deepEqual(names, new Set(["git-0IfcxY", "entry"]));
  assert.ok(caches.every((c) => c.eligible === true && c.blockers.length === 0));
});

test("codex: sessions are report-only history — visible size, never eligible", async () => {
  const home = await makeCodexHome();
  const candidates = await codexProvider().discover(context(home));
  const sessions = candidates.filter((c) => c.category === "ai-history" && targetPath(c).includes(`${path.sep}sessions${path.sep}`));
  assert.ok(sessions.length > 0, "expected at least one sessions candidate");
  for (const candidate of sessions) {
    assert.equal(candidate.eligible, false);
    assert.ok(candidate.blockers.includes(HISTORY_BLOCKER));
    assert.ok(candidate.bytes > 0);
  }
});

test("codex: sqlite databases (logs_*, thread_history_*) are report-only history with sidecars summed in", async () => {
  const home = await makeCodexHome();
  const candidates = await codexProvider().discover(context(home));
  const sqlite = candidates.filter((c) => targetPath(c).endsWith(".sqlite"));
  const byName = new Map(sqlite.map((c) => [path.basename(targetPath(c)), c]));
  assert.deepEqual(new Set(byName.keys()), new Set(["logs_2.sqlite", "thread_history_1.sqlite"]));
  for (const candidate of byName.values()) {
    assert.equal(candidate.category, "ai-history");
    assert.equal(candidate.eligible, false);
    assert.ok(candidate.blockers.includes(HISTORY_BLOCKER));
  }
  // logs_2.sqlite has -wal/-shm sidecars: 100 + 50 + 20 bytes, not just the main file's 100.
  assert.equal(byName.get("logs_2.sqlite")?.bytes, 170);
  assert.equal(byName.get("thread_history_1.sqlite")?.bytes, 80);
});

test("codex: never touches plugins or state/memories/goals/queue sqlite files", async () => {
  const home = await makeCodexHome();
  const candidates = await codexProvider().discover(context(home));
  const forbidden = ["plugins", "state_5.sqlite", "memories_1.sqlite", "goals_3.sqlite", "queue_7.sqlite"];
  for (const candidate of candidates) {
    for (const name of forbidden) assert.ok(!targetPath(candidate).includes(name), `candidate touched ${name}: ${targetPath(candidate)}`);
  }
});

test("codex: CODEX_HOME overrides the default ~/.codex root", async () => {
  const home = await tmpHome("agentclean-codex-default-");
  const other = await tmpHome("agentclean-codex-override-");
  await mkdir(path.join(other, "cache", "entry"), { recursive: true });
  await writeFile(path.join(other, "cache", "entry", "data"), "x");
  await age(path.join(other, "cache", "entry"));
  const candidates = await codexProvider().discover(context(home, { CODEX_HOME: other }));
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => targetPath(c).startsWith(other)));
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

test("cursor: resolves the real per-platform IDE data root, never ~/.cursor/extensions", async () => {
  const home = await tmpHome("agentclean-cursor-");
  await mkdir(path.join(home, ".cursor", "extensions", "some-ext"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "extensions", "some-ext", "bin"), "installed software");

  // macOS
  await mkdir(path.join(home, "Library", "Application Support", "Cursor", "Cache", "entry"), { recursive: true });
  await writeFile(path.join(home, "Library", "Application Support", "Cursor", "Cache", "entry", "data"), "x");
  await age(path.join(home, "Library", "Application Support", "Cursor", "Cache", "entry"));
  await withPlatform("darwin", async () => {
    const candidates = await cursorProvider().discover(context(home));
    assert.ok(candidates.some((c) => targetPath(c).includes(path.join("Library", "Application Support", "Cursor"))));
    assert.ok(candidates.every((c) => !targetPath(c).includes(path.join(".cursor", "extensions"))));
  });

  // Linux, default XDG_CONFIG_HOME
  await mkdir(path.join(home, ".config", "Cursor", "Cache", "entry"), { recursive: true });
  await writeFile(path.join(home, ".config", "Cursor", "Cache", "entry", "data"), "x");
  await age(path.join(home, ".config", "Cursor", "Cache", "entry"));
  await withPlatform("linux", async () => {
    const candidates = await cursorProvider().discover(context(home));
    assert.ok(candidates.some((c) => targetPath(c).includes(path.join(".config", "Cursor"))));
  });

  // Linux, XDG_CONFIG_HOME override
  const xdgConfig = await tmpHome("agentclean-cursor-xdg-");
  await mkdir(path.join(xdgConfig, "Cursor", "Cache", "entry"), { recursive: true });
  await writeFile(path.join(xdgConfig, "Cursor", "Cache", "entry", "data"), "x");
  await age(path.join(xdgConfig, "Cursor", "Cache", "entry"));
  await withPlatform("linux", async () => {
    const candidates = await cursorProvider().discover(context(home, { XDG_CONFIG_HOME: xdgConfig }));
    assert.ok(candidates.every((c) => targetPath(c).startsWith(xdgConfig)));
    assert.ok(candidates.length > 0);
  });

  // Windows, APPDATA
  const appData = await tmpHome("agentclean-cursor-appdata-");
  await mkdir(path.join(appData, "Cursor", "Cache", "entry"), { recursive: true });
  await writeFile(path.join(appData, "Cursor", "Cache", "entry", "data"), "x");
  await age(path.join(appData, "Cursor", "Cache", "entry"));
  await withPlatform("win32", async () => {
    const candidates = await cursorProvider().discover(context(home, { APPDATA: appData }));
    assert.ok(candidates.every((c) => targetPath(c).startsWith(appData)));
    assert.ok(candidates.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Cline — verified, report-only task history across VS Code-family hosts
// ---------------------------------------------------------------------------

interface ClineFixtureOptions {
  taskHistory?: boolean;
  tasks?: boolean;
  checkpoints?: boolean;
  settings?: boolean;
}

async function makeClineInstall(root: string, opts: ClineFixtureOptions = {}): Promise<void> {
  const { taskHistory = true, tasks = true, checkpoints = true, settings = true } = opts;
  await mkdir(root, { recursive: true });
  if (taskHistory) {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(path.join(root, "state", "taskHistory.json"), "x".repeat(10));
  }
  if (tasks) {
    await mkdir(path.join(root, "tasks", "task-1"), { recursive: true });
    await writeFile(path.join(root, "tasks", "task-1", "api_conversation_history.json"), "x".repeat(40));
    await writeFile(path.join(root, "tasks", "task-1", "ui_messages.json"), "x".repeat(20));
  }
  if (checkpoints) {
    await mkdir(path.join(root, "checkpoints", "task-1"), { recursive: true });
    await writeFile(path.join(root, "checkpoints", "task-1", "shadow-git-data"), "x".repeat(30));
  }
  if (settings) {
    await mkdir(path.join(root, "settings"), { recursive: true });
    await writeFile(path.join(root, "settings", "cline_mcp_settings.json"), "live mcp config, never a candidate");
  }
}

function clineRoot(home: string, editorRoot: string[]): string {
  return path.join(home, ...editorRoot, "User", "globalStorage", "saoudrizwan.claude-dev");
}

test("cline: detect() finds nothing and discover() is empty on a machine with no host editor install", async () => {
  const home = await tmpHome("agentclean-cline-none-");
  const detection = await withPlatform("darwin", () => clineProvider().detect(context(home)));
  assert.equal(detection.status, "verified");
  assert.equal(detection.root, undefined);
  assert.deepEqual(await withPlatform("darwin", () => clineProvider().discover(context(home))), []);
});

test("cline: task history + checkpoints are one report-only ai-history candidate; settings/cline_mcp_settings.json is never touched", async () => {
  const home = await tmpHome("agentclean-cline-");
  const root = clineRoot(home, ["Library", "Application Support", "Code"]);
  await makeClineInstall(root);

  const detection = await withPlatform("darwin", () => clineProvider().detect(context(home)));
  assert.equal(detection.status, "verified");
  assert.ok(detection.root?.includes("saoudrizwan.claude-dev"));

  const candidates = await withPlatform("darwin", () => clineProvider().discover(context(home)));
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.category, "ai-history");
  assert.equal(candidate.eligible, false);
  assert.ok(candidate.blockers.includes(HISTORY_BLOCKER));
  assert.ok(candidate.bytes > 0);
  assert.ok(!targetPath(candidate).includes(`${path.sep}settings${path.sep}`) && !targetPath(candidate).endsWith("settings"));

  const revalidation = await clineProvider().revalidate(candidate, context(home));
  assert.equal(revalidation.ok, false);
  const execution = await clineProvider().execute(candidate, context(home));
  assert.equal(execution.ok, false);
});

test("cline: resolves Code, Code - Insiders, Cursor, VSCodium, and Windsurf identically on macOS", async () => {
  for (const editorName of ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"]) {
    const home = await tmpHome("agentclean-cline-editors-");
    const root = clineRoot(home, ["Library", "Application Support", editorName]);
    await makeClineInstall(root);
    const candidates = await withPlatform("darwin", () => clineProvider().discover(context(home)));
    assert.equal(candidates.length, 1, `expected a candidate for ${editorName}`);
    assert.ok(targetPath(candidates[0]).startsWith(root), `candidate for ${editorName} should be under its own root`);
  }
});

test("cline: resolves under Cursor's globalStorage on Linux (XDG_CONFIG_HOME default), and APPDATA on Windows", async () => {
  const home = await tmpHome("agentclean-cline-linux-");
  const linuxRoot = clineRoot(home, [".config", "Cursor"]);
  await makeClineInstall(linuxRoot);
  const linuxCandidates = await withPlatform("linux", () => clineProvider().discover(context(home)));
  assert.equal(linuxCandidates.length, 1);
  assert.ok(targetPath(linuxCandidates[0]).startsWith(path.join(home, ".config", "Cursor")));

  const appData = await tmpHome("agentclean-cline-appdata-");
  const winRoot = clineRoot(appData, ["Code"]);
  await makeClineInstall(winRoot);
  const winCandidates = await withPlatform("win32", () => clineProvider().discover(context(home, { APPDATA: appData })));
  assert.equal(winCandidates.length, 1);
  assert.ok(targetPath(winCandidates[0]).startsWith(appData));
});

test("cline: two simultaneous installs (Code and Cursor) each produce their own report-only candidate", async () => {
  const home = await tmpHome("agentclean-cline-multi-");
  await makeClineInstall(clineRoot(home, ["Library", "Application Support", "Code"]));
  await makeClineInstall(clineRoot(home, ["Library", "Application Support", "Cursor"]));
  const candidates = await withPlatform("darwin", () => clineProvider().discover(context(home)));
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.category === "ai-history" && c.eligible === false));
});

test("cline: an installed extension with no task data at all contributes nothing", async () => {
  const home = await tmpHome("agentclean-cline-empty-");
  const root = clineRoot(home, ["Library", "Application Support", "Code"]);
  await mkdir(root, { recursive: true }); // extension folder exists, but Cline never ran a task
  const candidates = await withPlatform("darwin", () => clineProvider().discover(context(home)));
  assert.deepEqual(candidates, []);
});

// ---------------------------------------------------------------------------
// Gemini CLI vs. Antigravity
// ---------------------------------------------------------------------------

test("gemini: no rule fires for a directory that is actually Antigravity data (old ~/.gemini/tmp claim is gone)", async () => {
  const home = await tmpHome("agentclean-gemini-");
  await mkdir(path.join(home, ".gemini", "tmp", "leftover"), { recursive: true });
  await writeFile(path.join(home, ".gemini", "tmp", "leftover", "data"), "x");
  await age(path.join(home, ".gemini", "tmp", "leftover"));
  const candidates = await geminiProvider().discover(context(home));
  assert.deepEqual(candidates, []);
  const detection = await geminiProvider().detect(context(home));
  assert.ok(detection.root);
});

test("antigravity: conversations+brain are one report-only history candidate per namespace, never eligible", async () => {
  const home = await tmpHome("agentclean-antigravity-");
  const ns = path.join(home, ".gemini", "antigravity-ide");
  await mkdir(path.join(ns, "conversations"), { recursive: true });
  await writeFile(path.join(ns, "conversations", "uuid1.pb"), "x".repeat(30));
  await writeFile(path.join(ns, "conversations", "uuid1.db"), "x".repeat(20));
  await mkdir(path.join(ns, "brain", "uuid1"), { recursive: true });
  await writeFile(path.join(ns, "brain", "uuid1", "notes.txt"), "x".repeat(50));

  const candidates = await antigravityProvider().discover(context(home));
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.category, "ai-history");
  assert.equal(candidate.eligible, false);
  assert.ok(candidate.blockers.includes(HISTORY_BLOCKER));
  assert.ok(candidate.blockers.includes("grouped-across-conversations-and-brain-directories"));
  assert.equal(candidate.bytes, 100);

  const revalidation = await antigravityProvider().revalidate(candidate, context(home));
  assert.equal(revalidation.ok, false);
  const execution = await antigravityProvider().execute(candidate, context(home));
  assert.equal(execution.ok, false);
});

test("antigravity: a namespace that doesn't exist on this machine contributes nothing", async () => {
  const home = await tmpHome("agentclean-antigravity-empty-");
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  const candidates = await antigravityProvider().discover(context(home));
  assert.deepEqual(candidates, []);
});

// ---------------------------------------------------------------------------
// OpenCode — dead ternary fix
// ---------------------------------------------------------------------------

test("opencode: resolves ~/.local/share/opencode identically regardless of platform (the ternary was dead code)", async () => {
  const home = await tmpHome("agentclean-opencode-");
  await mkdir(path.join(home, ".local", "share", "opencode", "cache", "entry"), { recursive: true });
  await writeFile(path.join(home, ".local", "share", "opencode", "cache", "entry", "data"), "x");
  await age(path.join(home, ".local", "share", "opencode", "cache", "entry"));

  const defaultCandidates = await opencodeProvider().discover(context(home));
  assert.equal(defaultCandidates.length, 1);
  assert.ok(targetPath(defaultCandidates[0]).startsWith(path.join(home, ".local", "share", "opencode")));

  const winCandidates = await withPlatform("win32", () => opencodeProvider().discover(context(home)));
  assert.deepEqual(
    winCandidates.map((c) => targetPath(c)),
    defaultCandidates.map((c) => targetPath(c)),
  );
});

test("opencode: honors XDG_DATA_HOME on every platform", async () => {
  const home = await tmpHome("agentclean-opencode-xdg-");
  const dataHome = await tmpHome("agentclean-opencode-datahome-");
  await mkdir(path.join(dataHome, "opencode", "cache", "entry"), { recursive: true });
  await writeFile(path.join(dataHome, "opencode", "cache", "entry", "data"), "x");
  await age(path.join(dataHome, "opencode", "cache", "entry"));

  const candidates = await opencodeProvider().discover(context(home, { XDG_DATA_HOME: dataHome }));
  assert.equal(candidates.length, 1);
  assert.ok(targetPath(candidates[0]).startsWith(path.join(dataHome, "opencode")));
});

// ---------------------------------------------------------------------------
// Claude Code — dead rules removed, protected names intact
// ---------------------------------------------------------------------------

test("claude: removed image-cache/debug rules mean those directories are never scanned even if present", async () => {
  const home = await tmpHome("agentclean-claude-");
  await mkdir(path.join(home, ".claude", "image-cache", "entry"), { recursive: true });
  await writeFile(path.join(home, ".claude", "image-cache", "entry", "data"), "x");
  await age(path.join(home, ".claude", "image-cache", "entry"));
  await mkdir(path.join(home, ".claude", "debug", "entry"), { recursive: true });
  await writeFile(path.join(home, ".claude", "debug", "entry", "data"), "x");
  await age(path.join(home, ".claude", "debug", "entry"));
  await mkdir(path.join(home, ".claude", "paste-cache", "entry"), { recursive: true });
  await writeFile(path.join(home, ".claude", "paste-cache", "entry", "data"), "x");
  await age(path.join(home, ".claude", "paste-cache", "entry"));

  const candidates = await claudeProvider().discover(context(home));
  assert.deepEqual(
    candidates.map((c) => path.basename(path.dirname(targetPath(c)))),
    ["paste-cache"],
  );
});
