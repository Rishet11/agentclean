import path from "node:path";
import { lstat } from "node:fs/promises";
import { FilesystemProvider, type DisposableRoot } from "./filesystem.js";
import { immediateChildren, measureTree } from "../core/filesystem.js";
import { fingerprintFromStats, type ActionResult, type Candidate, type ExecuteContext, type ProviderDetection, type StorageProvider, type Validation } from "../core/types.js";
import { hashValue } from "../core/plan.js";
import { safeRealPath } from "../core/paths.js";

/**
 * Every root resolver below reads `context.home` / `context.env` instead of calling
 * `homePath()` / `os.homedir()` directly, so a test can point a provider at a fake
 * home without mutating `process.env` or `process.env.HOME`. `process.platform` is
 * still read directly where the real tool's storage location genuinely differs by
 * OS (Cursor) — tests cover those branches by stubbing `process.platform`, since
 * `ExecuteContext` has no platform field of its own.
 */

/** All conversation transcripts / chat history are report-only until an explicit
 * opt-in flag exists: emitted with visible size, but never eligible for deletion.
 * There is no such flag today — do not invent one. */
const HISTORY_BLOCKER = "history-requires-explicit-opt-in";

function markHistoryReportOnly(candidate: Candidate): Candidate {
  if (candidate.category !== "ai-history") return candidate;
  if (candidate.eligible === false && candidate.blockers.includes(HISTORY_BLOCKER)) return candidate;
  return { ...candidate, eligible: false, blockers: [...new Set([...candidate.blockers, HISTORY_BLOCKER])] };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function claudeRoot(context: ExecuteContext): string {
  return context.env.CLAUDE_CONFIG_DIR ? path.resolve(context.env.CLAUDE_CONFIG_DIR) : path.join(context.home, ".claude");
}

// image-cache and debug do not exist on the measured machine; removed rather than
// left as dead rules that always report zero candidates (see item 5 of the brief).
const claudeRoots: DisposableRoot[] = [
  { relativePath: "paste-cache", category: "ai-caches", reason: "Claude Code paste cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "session-env", category: "ai-caches", reason: "Claude Code session environment data", autoSafe: false, minAgeDays: 30 },
];

// Never a target, even indirectly: plugins/skills (installed extensions),
// settings.json/memory (live config), .credentials.json (secrets), and
// file-history/backups, which are Claude's own undo for file edits.
const claudeProtectedNames = new Set(["settings.json", "plugins", "memory", "skills", ".credentials.json", "file-history", "backups"]);

export function claudeProvider(): FilesystemProvider {
  return new FilesystemProvider("claude", "Claude Code", claudeRoot, claudeRoots, claudeProtectedNames);
}

// ---------------------------------------------------------------------------
// Gemini CLI vs. Antigravity
// ---------------------------------------------------------------------------

/**
 * `~/.gemini` is documented as gemini-cli's own config root (settings.json,
 * GEMINI.md, cached credentials — github.com/google-gemini/gemini-cli), but on
 * this machine the same directory holds ~4 GB of Google Antigravity IDE data
 * instead (antigravity-ide, antigravity, antigravity-browser-profile — verified:
 * Antigravity stores its data under `~/.gemini/<product>/...` on all three OSes,
 * per Google's Antigravity developer forum). The two tools share this root by
 * design, not by our guess, so we must not assume "gemini" in a path name means
 * gemini-cli. No disposable gemini-cli-specific subdirectory (the previous
 * `tmp` rule) could be confirmed from official docs, so geminiRoots stays empty
 * until one is verified rather than repeating an unconfirmed claim.
 */
function geminiRoot(context: ExecuteContext): string {
  return path.join(context.home, ".gemini");
}

const geminiRoots: DisposableRoot[] = [];

export function geminiProvider(): FilesystemProvider {
  return new FilesystemProvider("gemini", "Gemini CLI", geminiRoot, geminiRoots, new Set(["settings.json"]));
}

/** Verified Antigravity namespaces sharing the `~/.gemini` root (see geminiRoot
 * comment): the desktop app, the standalone IDE, and the CLI each keep their own
 * `<namespace>/conversations` and `<namespace>/brain` pair. */
const antigravityNamespaces = ["antigravity", "antigravity-ide", "antigravity-cli"] as const;

/**
 * Antigravity's `conversations/<uuid>.{pb,db}` and `brain/<uuid>/` are two
 * directories that together describe one conversation's history; deleting one
 * without the other leaves a dangling reference, so a single-target `Candidate`
 * cannot delete this atomically. Report-only: one candidate per namespace,
 * summing both directories' bytes, forced ineligible like all ai-history.
 */
class AntigravityProvider implements StorageProvider {
  readonly status = "verified" as const;
  readonly id = "antigravity";
  readonly name = "Antigravity";

  async detect(context: ExecuteContext): Promise<ProviderDetection> {
    const root = geminiRoot(context);
    const exists = await safeRealPath(root);
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      details: exists ? "documented data root (shared with gemini-cli)" : "documented data root not present",
      root: exists,
      capabilities: antigravityNamespaces.map((namespace) => `ai-history:${namespace}/conversations+brain`),
    };
  }

  async discover(context: ExecuteContext): Promise<Candidate[]> {
    const root = geminiRoot(context);
    if (!(await safeRealPath(root))) return [];
    const candidates: Candidate[] = [];
    for (const namespace of antigravityNamespaces) {
      const namespaceRoot = path.join(root, namespace);
      const conversations = path.join(namespaceRoot, "conversations");
      const brain = path.join(namespaceRoot, "brain");
      const [conversationsMeasured, brainMeasured] = await Promise.all([measureTree(conversations).catch(() => undefined), measureTree(brain).catch(() => undefined)]);
      if (!conversationsMeasured && !brainMeasured) continue;
      const anchor = conversationsMeasured ? conversations : brain;
      let stats;
      try {
        stats = await lstat(anchor);
      } catch {
        continue;
      }
      const evidence = [`documented Antigravity namespace ${namespace} (shared ~/.gemini root)`];
      if (conversationsMeasured) evidence.push(`${namespace}/conversations: ${conversationsMeasured.fileCount} files`);
      if (brainMeasured) evidence.push(`${namespace}/brain: ${brainMeasured.fileCount} files`);
      candidates.push({
        id: hashValue({ provider: this.id, target: namespaceRoot, category: "ai-history" }).slice(0, 16),
        provider: this.id,
        providerStatus: this.status,
        category: "ai-history",
        action: "delete",
        target: { kind: "path", path: anchor },
        reason: `Antigravity (${namespace}) conversation transcripts and brain knowledge base`,
        evidence,
        bytes: (conversationsMeasured?.bytes ?? 0) + (brainMeasured?.bytes ?? 0),
        fileCount: (conversationsMeasured?.fileCount ?? 0) + (brainMeasured?.fileCount ?? 0),
        mtimeMs: stats.mtimeMs,
        fingerprint: fingerprintFromStats(stats),
        eligible: false,
        blockers: [HISTORY_BLOCKER, "grouped-across-conversations-and-brain-directories"],
        autoSafe: false,
        partialMeasurement: conversationsMeasured?.partial || brainMeasured?.partial,
        metadata: { root: namespaceRoot, relativePath: namespace },
      });
    }
    return candidates;
  }

  explain(candidate: Candidate): string {
    return `${candidate.reason}. Two directories that must stay in sync, and history is report-only until an explicit opt-in exists.`;
  }

  async revalidate(): Promise<Validation> {
    return { ok: false, reason: HISTORY_BLOCKER };
  }

  async execute(): Promise<ActionResult> {
    return { ok: false, bytes: 0, reason: HISTORY_BLOCKER };
  }
}

/** Not wired into registry.ts yet — that happens at merge time (see brief). */
export function antigravityProvider(): StorageProvider {
  return new AntigravityProvider();
}

// ---------------------------------------------------------------------------
// Cline (VS Code / Cursor extension) — stays diagnostic-only
// ---------------------------------------------------------------------------

export function clineProvider(): DiagnosticProvider {
  return new DiagnosticProvider("cline", "Cline", (context) => {
    // Verified: extension id is `saoudrizwan.claude-dev` (github.com/cline/cline;
    // the rebrand from "Claude Dev" kept the original id). VS Code / Cursor store
    // per-extension data at <editor-user-data>/User/globalStorage/<extension-id>,
    // a well-known Code/Cursor convention. What is NOT verified: which of these
    // editors (or VSCodium, or another fork) the user actually has Cline installed
    // in — that depends on the machine, and `~/.cline` does not exist on the one
    // this was measured on. Stays diagnostic-only until an install is confirmed.
    const globalStorage = (editorRoot: string) => path.join(editorRoot, "User", "globalStorage", "saoudrizwan.claude-dev");
    if (process.platform === "win32") {
      const appData = context.env.APPDATA || path.join(context.home, "AppData", "Roaming");
      return [globalStorage(path.join(appData, "Code")), globalStorage(path.join(appData, "Cursor"))];
    }
    if (process.platform === "darwin") {
      const appSupport = path.join(context.home, "Library", "Application Support");
      return [globalStorage(path.join(appSupport, "Code")), globalStorage(path.join(appSupport, "Cursor"))];
    }
    const xdgConfig = context.env.XDG_CONFIG_HOME || path.join(context.home, ".config");
    return [globalStorage(path.join(xdgConfig, "Code")), globalStorage(path.join(xdgConfig, "Cursor"))];
  });
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function opencodeRoot(context: ExecuteContext): string {
  // opencode resolves its data dir via the xdg-basedir library, which applies
  // Linux XDG conventions even on Windows rather than %APPDATA% (a known
  // opencode bug: sst/opencode#8235, anomalyco/opencode#18633) — so there is no
  // platform branch here. The old `win32 ? x : x` ternary was dead code
  // pretending to be a platform check; it always returned the same path because
  // that IS what opencode does today. It does honor $XDG_DATA_HOME when set.
  const dataHome = context.env.XDG_DATA_HOME ? path.resolve(context.env.XDG_DATA_HOME) : path.join(context.home, ".local", "share");
  return path.join(dataHome, "opencode");
}

const opencodeRoots: DisposableRoot[] = [
  { relativePath: "cache", category: "ai-caches", reason: "OpenCode reconstructible cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "log", category: "ai-caches", reason: "OpenCode logs", autoSafe: false, minAgeDays: 90 },
];

export function opencodeProvider(): FilesystemProvider {
  return new FilesystemProvider("opencode", "OpenCode", opencodeRoot, opencodeRoots, new Set(["auth.json", "project", "global", "plugins"]));
}

// ---------------------------------------------------------------------------
// Diagnostic provider base (kept for Cline — see clineProvider above — and any
// future provider whose deletion semantics can't be verified yet).
// ---------------------------------------------------------------------------

export class DiagnosticProvider implements StorageProvider {
  readonly status = "diagnostic" as const;

  constructor(readonly id: string, readonly name: string, private readonly possibleRoots: (context: ExecuteContext) => string[]) {}

  async detect(context: ExecuteContext): Promise<ProviderDetection> {
    const roots = this.possibleRoots(context);
    let root: string | undefined;
    for (const candidate of roots) {
      // eslint-disable-next-line no-await-in-loop -- small, fixed candidate list
      if (await safeRealPath(candidate)) {
        root = candidate;
        break;
      }
    }
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      details: root ? "candidate root present but deletion semantics require verification" : "no candidate root found",
      root,
      capabilities: ["diagnostic-only"],
    };
  }

  async discover(): Promise<never[]> {
    return [];
  }

  explain(): string {
    return "This provider is diagnostic-only until its maintained storage and cleanup semantics are verified.";
  }

  async revalidate(): Promise<Validation> {
    return { ok: false, reason: "diagnostic-only provider" };
  }

  async execute(): Promise<ActionResult> {
    return { ok: false, bytes: 0, reason: "diagnostic-only provider" };
  }
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

function codexRoot(context: ExecuteContext): string {
  // Verified: CODEX_HOME overrides the config directory, defaulting to
  // ~/.codex (github.com/openai/codex, codex-rs/core/src/config.rs).
  return context.env.CODEX_HOME ? path.resolve(context.env.CODEX_HOME) : path.join(context.home, ".codex");
}

const codexRoots: DisposableRoot[] = [
  { relativePath: ".tmp", category: "ai-caches", reason: "Codex scratch workspace (git clones, plugin sync)", autoSafe: false, minAgeDays: 30 },
  { relativePath: "cache", category: "ai-caches", reason: "Codex disposable cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "shell_snapshots", category: "ai-caches", reason: "Codex shell snapshot cache", autoSafe: false, minAgeDays: 30 },
  // Rollout transcripts (sessions/YYYY/MM/DD/rollout-*.jsonl) are conversation
  // history: report-only, forced ineligible below regardless of age.
  { relativePath: "sessions", category: "ai-history", reason: "Codex rollout session transcripts", autoSafe: false, minAgeDays: 0 },
];

// `plugins` (installed software) and the root itself are never scanned: none of
// the rules above target them, so there is no protectedNames entry to add.
const codexInner = new FilesystemProvider("codex", "Codex CLI", codexRoot, codexRoots, new Set());

/**
 * ~/.codex also holds sqlite databases directly in its root, named
 * `<stem>_<schema-version>.sqlite` (state_5.sqlite, memories_1.sqlite,
 * goals_*.sqlite, queue_*.sqlite, logs_2.sqlite, thread_history_1.sqlite — 7
 * total, not 2). Only `logs` and `thread_history` are conversation/telemetry
 * history worth surfacing; state/memories/goals/queue are live application
 * state and must never be touched, so they are excluded by allowlist, not by
 * age or path exclusion. Any `-wal`/`-shm` sidecar is measured and reported
 * together with its main file (never separately) so a size never implies a
 * deletable fragment of a database.
 */
const codexSqliteStemAllowlist = new Set(["logs", "thread_history"]);
const codexSqliteName = /^(.+)_(\d+)\.sqlite$/;
const sqliteSidecarSuffixes = ["-wal", "-shm"];

async function discoverCodexSqliteHistory(root: string): Promise<Candidate[]> {
  let children: string[];
  try {
    children = await immediateChildren(root);
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const target of children) {
    const name = path.basename(target);
    const match = codexSqliteName.exec(name);
    if (!match || !codexSqliteStemAllowlist.has(match[1])) continue;
    let stats;
    try {
      stats = await lstat(target);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink() || stats.isDirectory()) continue;
    let bytes = stats.size;
    let fileCount = 1;
    const sidecars: string[] = [];
    for (const suffix of sqliteSidecarSuffixes) {
      const sidecarPath = `${target}${suffix}`;
      try {
        // eslint-disable-next-line no-await-in-loop -- two fixed suffixes
        const sidecarStats = await lstat(sidecarPath);
        if (!sidecarStats.isSymbolicLink()) {
          bytes += sidecarStats.size;
          fileCount += 1;
          sidecars.push(`${name}${suffix}`);
        }
      } catch {
        // no sidecar for this file, nothing to add
      }
    }
    candidates.push({
      id: hashValue({ provider: "codex", target, category: "ai-history" }).slice(0, 16),
      provider: "codex",
      providerStatus: "verified",
      category: "ai-history",
      action: "delete",
      target: { kind: "path", path: target },
      reason: `Codex sqlite database: ${name}`,
      evidence: ["documented root file", sidecars.length ? `sidecars measured with main file: ${sidecars.join(", ")}` : "no -wal/-shm sidecar present"],
      bytes,
      fileCount,
      mtimeMs: stats.mtimeMs,
      fingerprint: fingerprintFromStats(stats),
      eligible: false,
      blockers: [HISTORY_BLOCKER],
      autoSafe: false,
      metadata: { root, relativePath: name },
    });
  }
  return candidates;
}

class CodexProvider implements StorageProvider {
  readonly status = "verified" as const;
  readonly id = "codex";
  readonly name = "Codex CLI";

  async detect(context: ExecuteContext): Promise<ProviderDetection> {
    const detection = await codexInner.detect(context);
    return { ...detection, capabilities: [...detection.capabilities, "ai-history:sqlite(logs,thread_history)"] };
  }

  async discover(context: ExecuteContext): Promise<Candidate[]> {
    const base = (await codexInner.discover(context)).map(markHistoryReportOnly);
    const root = codexRoot(context);
    const sqlite = (await safeRealPath(root)) ? await discoverCodexSqliteHistory(root) : [];
    return [...base, ...sqlite];
  }

  explain(candidate: Candidate): string {
    return codexInner.explain(candidate);
  }

  async revalidate(candidate: Candidate, context: ExecuteContext): Promise<Validation> {
    if (candidate.category === "ai-history") return { ok: false, reason: HISTORY_BLOCKER };
    return codexInner.revalidate(candidate, context);
  }

  async execute(candidate: Candidate): Promise<ActionResult> {
    if (candidate.category === "ai-history") return { ok: false, bytes: 0, reason: HISTORY_BLOCKER };
    return codexInner.execute(candidate);
  }
}

export function codexProvider(): StorageProvider {
  return new CodexProvider();
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * `~/.cursor` (extensions: 618 MB of installed software, never a target; plus
 * CLI config) is NOT the IDE's data root. The actual Cursor IDE (Electron/VS
 * Code fork) keeps its user data at the per-platform Application Support
 * location — verified against Cursor's own CLI configuration docs and
 * community setup guides: macOS `~/Library/Application Support/Cursor`, Linux
 * `${XDG_CONFIG_HOME:-~/.config}/Cursor`, Windows `%APPDATA%/Cursor`. No
 * documented environment variable overrides that root for the IDE itself (the
 * CLI's own `CURSOR_CONFIG_DIR` is a separate, narrower setting) — none is
 * invented here.
 */
function cursorRoot(context: ExecuteContext): string {
  if (process.platform === "win32") {
    return path.join(context.env.APPDATA || path.join(context.home, "AppData", "Roaming"), "Cursor");
  }
  if (process.platform === "darwin") {
    return path.join(context.home, "Library", "Application Support", "Cursor");
  }
  return path.join(context.env.XDG_CONFIG_HOME || path.join(context.home, ".config"), "Cursor");
}

// Standard Electron/Chromium disposable caches, all re-created on demand.
const cursorRoots: DisposableRoot[] = [
  { relativePath: "Cache", category: "ai-caches", reason: "Cursor Electron HTTP cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "CachedData", category: "ai-caches", reason: "Cursor Electron V8 cached data", autoSafe: false, minAgeDays: 30 },
  { relativePath: "Code Cache", category: "ai-caches", reason: "Cursor Electron code cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "GPUCache", category: "ai-caches", reason: "Cursor Electron GPU shader cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "blob_storage", category: "ai-caches", reason: "Cursor Electron blob storage cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "Crashpad", category: "ai-caches", reason: "Cursor Electron crash dump cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "logs", category: "ai-caches", reason: "Cursor application logs", autoSafe: false, minAgeDays: 90 },
];

export function cursorProvider(): FilesystemProvider {
  return new FilesystemProvider("cursor", "Cursor", cursorRoot, cursorRoots, new Set());
}
