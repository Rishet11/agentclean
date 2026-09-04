# AgentClean

A fail-closed cleanup tool for storage created by AI coding tools, Git worktrees, project dependencies, virtual environments, build output, and developer package caches.

AI coding workflows create more than source files. They can leave behind parallel worktrees, conversation transcripts, tool results, checkpoints, downloaded runtimes, logs, and package caches. On Windows, those folders can grow quietly inside `%USERPROFILE%` and `%LOCALAPPDATA%`, while open file handles make deletion unreliable.

This project exists to reclaim that space without pretending that an aggressive recursive delete is safe.

## Safety promise

The tool is designed around one rule:

> If ownership, scope, state, or deletion success cannot be proven, the tool does not delete the item.

That means it may leave some storage behind. This is intentional. “100% reliable” means:

- no arbitrary home-directory deletion;
- no force removal of dirty or locked worktrees;
- no following symlinks, junctions, mounts, or unknown reparse points;
- no deletion based only on a familiar-looking folder name;
- no process termination, administrator escalation, ACL changes, registry edits, or reboot-time deletion;
- revalidation immediately before every destructive action;
- honest reporting when an item is skipped or fails.

The tool cannot guarantee that Windows or another process will release a file handle. It can guarantee that a sharing violation becomes a visible, bounded failure instead of an unsafe workaround.

## Planned usage

The package will be distributed through npm and run without a global install:

```powershell
npx --yes agentclean scan
npx --yes agentclean clean
```

The default operation is read-only. A normal cleanup prints a deletion plan and asks for confirmation.

```powershell
# Inspect known AI/provider storage without changing anything
npx --yes agentclean scan

# Find the biggest project multipliers: node_modules, venvs, and build output
npx --yes agentclean scan --project-artifacts --root C:\\Users\\you\\src

# Save a versioned plan for review or automation
npx --yes agentclean scan --project-artifacts --json --out cleanup-plan.json

# Explain one candidate using its evidence and blockers
npx --yes agentclean explain <candidate-id>

# Re-scan, show the plan, and ask for confirmation
npx --yes agentclean clean

# Never mutate; useful in CI or scripts
npx --yes agentclean clean --dry-run

# Execute only an explicitly reviewed plan
npx --yes agentclean clean --plan cleanup-plan.json --yes

# Use only actions allowed by the safe automatic policy
npx --yes agentclean auto --once
```

The command surface is the product contract while implementation is being completed. The package is not published yet; local development uses the commands below.

## What it cleans

The first release is deliberately limited to known providers and explicit roots.

| Provider | Detection | Cleanup status | Default automatic cleanup |
| --- | --- | --- | --- |
| Git worktrees | Git porcelain metadata and status | Clean linked worktrees only; dirty/locked/ambiguous trees are skipped | No, unless explicitly allowlisted |
| Project artifacts | Explicit roots plus manifests/markers | `node_modules`, `.venv`, `venv`, `env`, `dist`, `build`, `.next`, `out`, `target`, `coverage`, `.turbo`; explicit review required | No |
| Claude Code | Documented `~/.claude` application data and `CLAUDE_CONFIG_DIR` | Documented disposable data; history requires explicit selection | No until policy is explicitly enabled |
| Gemini CLI | Documented `~/.gemini` and project `.gemini` boundaries | Temporary/session data only when documented | No until policy is explicitly enabled |
| Cline | Documented `~/.cline`, `~/.cline/data`, and `CLINE_DATA_DIR` | Diagnostic-only pending a verified deletion contract | No |
| OpenCode | Documented Windows data, log, cache, and project storage locations | Cache actions can be exposed separately; auth and project data are protected | No until policy is explicitly enabled |
| Codex | Detected when reliable paths are available | Diagnostic-only until maintained cleanup semantics are verified | No |
| Cursor | Detected when reliable paths are available | Diagnostic-only until maintained cleanup semantics are verified | No |
| npm | `npm config get cache` | Uses npm’s own verify/clean commands | No |
| pnpm | `pnpm store path` | Uses `pnpm store prune` | Yes, when explicitly enabled |

A provider is not allowed to delete a path merely because it contains words such as `cache`, `temp`, `session`, or `worktree`. Each deletable candidate must have positive ownership evidence and a documented category.

Project artifacts are opt-in because they are large but project-specific. `--project-artifacts` scans only explicit roots and reports `node_modules`, Python virtual environments, and recognized build output when it finds manifest or environment evidence. It never scans the whole home directory, and automatic cleanup never selects these categories.

## What it never cleans by default

- credentials, OAuth tokens, API keys, or auth databases;
- provider settings, MCP configuration, plugins, skills, rules, and memory;
- Git main worktrees or `.git` administrative data;
- dirty, locked, active, or unverified worktrees;
- arbitrary `node_modules` folders;
- arbitrary folders under the home directory;
- unknown provider directories;
- files held open by another process when Windows refuses deletion.

## How the safety model works

Cleanup has separate inventory and execution phases.

1. **Scan:** providers discover candidates without mutation.
2. **Plan:** the tool records paths/actions, ownership evidence, category, provider version, size, timestamps, fingerprints, blockers, and a SHA-256 plan hash.
3. **Review:** the human or automation reviews the exact candidates and categories.
4. **Revalidate:** every candidate is checked again immediately before execution.
5. **Execute:** candidates are processed one at a time; failures do not become force deletes.
6. **Manifest:** every result is recorded so interrupted runs remain truthful and resumable.

If a candidate changes after scanning, the tool skips it as `changed-since-scan`. If a provider version or policy changes, the old plan is invalid. Paths are canonicalized and checked against allowed roots; symlinks and Windows junctions are not followed.

## Automatic cleanup

Automatic cleanup is policy-driven, not a global “delete old files” switch.

The safe policy can handle provider-declared disposable caches older than the configured age threshold and integrity-aware package-manager commands. It does not delete history, memory, credentials, settings, plugins, or worktrees unless those categories are separately enabled.

Scheduled cleanup is opt-in and user-scoped:

- Windows Task Scheduler;
- macOS launch agents;
- Linux systemd user timers, with an explicit cron fallback if requested.

Every scheduled run uses a policy hash, a single-instance lock, a result manifest, and fail-closed behavior when provider state is unknown. No cloud telemetry or transcript-content upload is required.

## Windows behavior

Windows is a primary target because AI tools commonly store large data under `%USERPROFILE%` and `%LOCALAPPDATA%`, and file handles can remain open briefly after an agent exits.

The cleaner:

- supports spaces, Unicode, UNC paths, and long paths;
- compares Windows paths case-insensitively;
- uses argument arrays instead of shell command strings;
- detects and rejects reparse points and junction escapes;
- retries transient sharing violations only within a bounded budget;
- reports the owning process only as a future diagnostic capability;
- never schedules deletion at reboot or kills a process automatically.

When a file is locked, close the relevant editor, terminal, agent, or desktop app and run the scan again.

## Local development

Requirements:

- Node.js 20 or newer;
- Git for worktree discovery and tests;
- npm.

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

Build output is written to `dist/`. The published shape is checked with `npm pack --dry-run`; before release, the tarball will also be executed through a temporary `npx --package` invocation.

## Privacy

The tool is local-first. It records metadata needed to explain and revalidate cleanup decisions:

- provider and category;
- normalized path;
- file count and logical size;
- timestamps and fingerprints;
- policy, evidence, blocker, and result information.

It does not index transcript contents, print prompts, upload files, collect credentials, or include raw provider command output in normal reports.

## Project documents

- [`docs/PRD.md`](docs/PRD.md) — product requirements, user stories, safety requirements, provider scope, and acceptance criteria.
- [`docs/CURRENT-STATE-AUDIT.md`](docs/CURRENT-STATE-AUDIT.md) — measured state of the implementation, coverage gaps, and open defects.
- [`docs/IMPROVEMENT-PLAN.md`](docs/IMPROVEMENT-PLAN.md) — prioritized roadmap for making the tool useful in practice.
- [`docs/WHY-NOT-JUST-ASK-AN-AI.md`](docs/WHY-NOT-JUST-ASK-AN-AI.md) — why a deterministic cleaner beats prompting an agent, and how the two fit together.
- [`LICENSE`](LICENSE) — MIT license.

## Research references

- [Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [Windows MoveFileEx documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
- [Windows Restart Manager](https://learn.microsoft.com/en-us/windows/win32/rstmgr/restart-manager-portal)
- [Claude Code application data](https://code.claude.com/docs/en/claude-directory)
- [Gemini CLI configuration](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html)
- [Cline configuration](https://docs.cline.bot/getting-started/config)
- [OpenCode troubleshooting and storage](https://opencode.ai/docs/troubleshooting/)
- [npm cache](https://docs.npmjs.com/cli/v11/commands/npm-cache/)
- [pnpm store](https://pnpm.io/cli/store)
