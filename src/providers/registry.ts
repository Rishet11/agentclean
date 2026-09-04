import type { StorageProvider } from "../core/types.js";
import { claudeProvider, clineProvider, codexProvider, cursorProvider, geminiProvider, opencodeProvider } from "./ai.js";
import { GitWorktreeProvider } from "./git.js";
import { npmProvider, pnpmProvider } from "./command.js";
import { bunProvider, goProvider, pipProvider, uvProvider, yarnProvider } from "./package-caches.js";
import { ProjectArtifactProvider } from "./project.js";

export function providers(): StorageProvider[] {
  return [new GitWorktreeProvider(), new ProjectArtifactProvider(), claudeProvider(), geminiProvider(), clineProvider(), opencodeProvider(), codexProvider(), cursorProvider(), npmProvider(), pnpmProvider(), uvProvider(), goProvider(), yarnProvider(), bunProvider(), pipProvider()];
}

export function providerMap(): Map<string, StorageProvider> {
  return new Map(providers().map((provider) => [provider.id, provider]));
}
