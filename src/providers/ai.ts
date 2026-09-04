import path from "node:path";
import { FilesystemProvider, type DisposableRoot } from "./filesystem.js";
import type { ExecuteContext, StorageProvider } from "../core/types.js";
import { homePath } from "../core/paths.js";

function envRoot(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  return env[variable] ? path.resolve(env[variable]) : fallback;
}

const claudeRoots: DisposableRoot[] = [
  { relativePath: "image-cache", category: "ai-caches", reason: "Claude Code image cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "paste-cache", category: "ai-caches", reason: "Claude Code paste cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "debug", category: "ai-caches", reason: "Claude Code debug data", autoSafe: false, minAgeDays: 30 },
  { relativePath: "session-env", category: "ai-caches", reason: "Claude Code session environment data", autoSafe: false, minAgeDays: 30 },
];

const geminiRoots: DisposableRoot[] = [
  { relativePath: "tmp", category: "ai-caches", reason: "Gemini CLI temporary project data", autoSafe: false, minAgeDays: 30 },
];

const clineRoots: DisposableRoot[] = [];

const opencodeRoots: DisposableRoot[] = [
  { relativePath: "cache", category: "ai-caches", reason: "OpenCode reconstructible cache", autoSafe: false, minAgeDays: 30 },
  { relativePath: "log", category: "ai-caches", reason: "OpenCode logs", autoSafe: false, minAgeDays: 90 },
];

export function claudeProvider(): FilesystemProvider {
  return new FilesystemProvider("claude", "Claude Code", (context) => envRoot(context.env, "CLAUDE_CONFIG_DIR", homePath(".claude")), claudeRoots, new Set(["settings.json", "plugins", "memory"]));
}

export function geminiProvider(): FilesystemProvider {
  return new FilesystemProvider("gemini", "Gemini CLI", () => homePath(".gemini"), geminiRoots, new Set(["settings.json"]));
}

export function clineProvider(): DiagnosticProvider {
  return new DiagnosticProvider("cline", "Cline", [homePath(".cline"), homePath("Documents", "Cline")]);
}

export function opencodeProvider(): FilesystemProvider {
  return new FilesystemProvider("opencode", "OpenCode", (context) => process.platform === "win32" ? homePath(".local", "share", "opencode") : homePath(".local", "share", "opencode"), opencodeRoots, new Set(["auth.json", "project", "global", "plugins"]));
}

export class DiagnosticProvider implements StorageProvider {
  readonly status = "diagnostic" as const;

  constructor(readonly id: string, readonly name: string, private readonly possibleRoots: string[]) {}

  async detect(context: ExecuteContext) {
    const existing = this.possibleRoots.find((root) => root === context.home || root.startsWith(`${context.home}${path.sep}`) || root === context.cwd || root.startsWith(`${context.cwd}${path.sep}`));
    return { id: this.id, name: this.name, status: this.status, details: "path semantics require verification before cleanup", root: existing, capabilities: ["diagnostic-only"] };
  }

  async discover(): Promise<never[]> { return []; }
  explain(): string { return "This provider is diagnostic-only until its maintained storage and cleanup semantics are verified."; }
  async revalidate(): Promise<{ ok: false; reason: string }> { return { ok: false, reason: "diagnostic-only provider" }; }
  async execute(): Promise<{ ok: false; bytes: number; reason: string }> { return { ok: false, bytes: 0, reason: "diagnostic-only provider" }; }
}

export function codexProvider(): DiagnosticProvider { return new DiagnosticProvider("codex", "Codex", [homePath(".codex")]); }
export function cursorProvider(): DiagnosticProvider { return new DiagnosticProvider("cursor", "Cursor", [homePath("AppData", "Roaming", "Cursor")]); }
