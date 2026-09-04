# Product Requirements Document

## 1. Product summary

**Product:** AgentClean  
**Working package name:** `agentclean`  
**Primary platform:** Windows  
**Distribution:** npm and `npx`  
**Project type:** local-first command-line utility

AgentClean helps developers find and safely reclaim disk space created by AI-assisted coding workflows. It focuses on storage that has a known owner: linked Git worktrees, AI-agent state, provider caches, and package-manager caches.

The product exists because AI coding changes the shape of local development. A developer may run several agents in parallel, switch providers, create temporary branches, open many previews, and repeatedly install packages. Each tool can persist conversations, tool outputs, checkpoints, runtimes, logs, and caches. A normal disk-cleaning utility cannot distinguish useful project data from disposable agent state, and a broad recursive delete can destroy credentials, work in progress, or an active checkout.

## 2. Problem statement

Developers need to answer three questions safely:

1. **What is consuming the space?**
2. **Is each item still needed or active?**
3. **Can it be removed without damaging a project, provider installation, or future recovery path?**

Current approaches are insufficient:

- manually searching `%USERPROFILE%` and `%LOCALAPPDATA%` is slow and easy to get wrong;
- deleting folders named `cache`, `temp`, or `sessions` uses naming guesses instead of ownership evidence;
- `git worktree prune` repairs Git metadata but does not safely identify every on-disk worktree;
- generic cleaners do not understand dirty worktrees, provider history, auth files, or AI-specific data loss;
- Windows can refuse deletion because an editor, terminal, runtime, or agent still holds a file handle.

The product must make the safe choice visible and actionable, even when the safe choice is to skip an item.

## 3. Goals

### Primary goals

- Provide a read-only inventory of known AI storage, Git worktrees, duplicated project dependencies, Python environments, and build artifacts.
- Explain why each item was found and what would be lost.
- Reclaim space through provider-aware, Git-aware, and explicit project-root operations.

- Work reliably with Windows paths, locks, permissions, and reparse points.
- Make destructive operations reviewable, reproducible, and revalidated.
- Support opt-in automatic cleanup with conservative policies.
- Ship as a directly runnable `npx` package with no install script.
- Keep all behavior local by default and avoid transcript-content collection.

### Safety goals

- Never delete an unknown path.
- Never follow a link or junction outside an allowed root.
- Never force-delete a dirty, locked, active, or ambiguous worktree.
- Never treat a failed deletion as a successful cleanup.
- Never silently widen the scope of an old plan.
- Never require administrator privileges for normal operation.

### Secondary goals

- Support macOS and Linux using the same provider contracts and safety rules.
- Provide machine-readable plans and result manifests for CI and scheduled runs.
- Make provider support independently testable and versioned.
- Allow new providers to be added without changing the executor’s safety invariants.

## 4. Non-goals

The first release will not:

- clean the whole disk;
- recursively delete arbitrary home-directory caches;
- delete every `node_modules` directory;
- force-remove dirty or locked Git worktrees;
- kill processes or change permissions to make deletion succeed;
- schedule reboot-time deletion;
- modify the Windows registry;
- upload files, transcripts, prompts, or credentials;
- support undocumented provider formats as deletable data;
- promise that every possible byte can be reclaimed.

## 5. Target users

### Individual AI-assisted developer

Runs several coding agents and wants to understand why the system drive is full without risking active projects.

### Repository maintainer

Uses many temporary worktrees and needs a safe way to remove completed clean worktrees while preserving dirty work.

### CI or workstation administrator

Needs a deterministic, user-scoped automatic policy with explicit exit codes, logs, and no administrator escalation.

### Provider integrator

Wants to add support for an AI tool while clearly separating credentials, configuration, history, caches, and disposable temporary data.

## 6. User stories

- As a developer, I can run `scan` and see which supported providers consume the most space.
- As a developer, I can see why a path is a candidate before deleting it.
- As a developer, I can save a scan plan and review it outside the tool.
- As a developer, I can clean only a selected category or provider.
- As a developer, I can trust that a worktree with uncommitted files will be skipped.
- As a developer, I can rerun cleanup after closing an app that held a Windows file lock.
- As an automation operator, I can run a reviewed plan with `--yes` and receive a non-zero result when anything is skipped or fails.
- As an automation operator, I can schedule only safe categories and inspect the last run manifest.
- As a provider integrator, I can mark a provider diagnostic-only until its storage semantics are verified.
- As a privacy-conscious developer, I can use the tool without sending local data to a server.

## 7. Command requirements

### `scan`

- Read-only by default.
- Discover only configured roots, current directory, explicit `--root` values, and exact provider paths.
- Display category, provider, path/action, age, size, reason, and blockers.
- Support `--json` and `--out`.
- Produce a schema-versioned plan with a cryptographic hash.

### `providers`

- Show detected provider versions and status.
- Distinguish `verified`, `diagnostic`, and `unavailable`.
- Show supported categories and automatic-policy capabilities.
- Never expose credentials or raw configuration content.

### `explain <candidate-id>`

- Resolve a candidate from the current plan or run manifest.
- Show ownership evidence, path boundary, category, estimated size, policy decision, and blockers.
- Explain what the provider considers reconstructible versus user-facing.

### `clean`

- Scan and display the plan before execution unless an explicit plan is supplied.
- Require interactive confirmation for destructive operation.
- Require both `--plan` and `--yes` for non-interactive execution.
- Support `--dry-run`, `--category`, `--provider`, and `--strict`.
- Revalidate each candidate immediately before action.
- Continue after an individual failure and report partial results.

### `auto`

- `auto --once` executes only the safe automatic policy.
- `auto install` creates a user-scoped scheduler entry.
- `auto status` reports policy, schedule, last result, and skipped/failed counts.
- `auto uninstall` removes only a scheduler entry created by the tool.
- Automatic mode fails closed when policy, provider version, ownership, or activity is unknown.

### `doctor`

- Check Node.js, Git, provider commands, configured roots, permissions, path capabilities, and scheduler state.
- Avoid changing the system during diagnostics.
- Return actionable but non-destructive messages.

### `config`

- Add/remove explicit project roots.
- Configure retention ages and automatic categories/providers.
- Store configuration in the platform-appropriate user config directory.
- Validate and hash policy before scheduled execution.

## 8. Candidate and policy model

A candidate is not simply a path. It includes:

- stable candidate ID;
- provider and provider status;
- category;
- path or provider command target;
- ownership evidence;
- logical byte and file-count estimate;
- modification time and file fingerprint;
- eligibility and blockers;
- automatic-policy eligibility;
- metadata needed for revalidation.

The categories are:

- `worktrees`;
- `ai-history`;
- `ai-caches`;
- `package-caches`.

The default automatic policy may select only provider-declared disposable caches and integrity-aware package-manager actions older than the configured age threshold. History and worktrees require explicit opt-in and separate confirmation.

## 9. Provider requirements

Every provider adapter must:

1. document its exact root and any environment-variable override;
2. identify protected files and directories;
3. classify data as history, cache, temporary, configuration, credentials, plugins, or memory;
4. report the provider version or source version used for the decision;
5. support discovery without mutation;
6. revalidate ownership and state before execution;
7. expose a provider-owned cleanup command when direct deletion is unsafe;
8. return diagnostic-only status when path or semantics are uncertain;
9. avoid returning file contents or secrets;
10. include unit and integration tests for protected boundaries.

Initial provider matrix:

| Provider | Exact evidence | Deletable in v1 | Notes |
| --- | --- | --- | --- |
| Git | `git worktree list --porcelain -z`, `git status --porcelain=v2` | Clean linked worktrees and selected Git metadata actions | Main worktree, dirty, locked, active, submodule, and ambiguous trees are protected |
| Claude Code | Maintained application-data documentation and `CLAUDE_CONFIG_DIR` | Documented disposable data | Auth, settings, plugins, memory, and project state protected |
| Gemini CLI | Maintained configuration and session-data documentation | Documented temporary/session data only when classified disposable | `.gemini` project instructions/settings protected |
| Cline | Maintained `~/.cline`, `CLINE_DATA_DIR` layout | Diagnostic-only — no verified install has been found on any tested machine, so it does not delete anything yet | Sessions and SQLite state would be history/data by default once implemented |
| OpenCode | Maintained Windows storage/cache documentation | Documented cache actions | Auth, project storage, and plugins protected |
| Codex | Documented `~/.codex` data root | Documented disposable data; session transcripts are report-only | Implemented — no longer diagnostic-only |
| Cursor | Documented platform app-support root | Documented disposable data | Implemented — no longer diagnostic-only |
| npm | `npm config get cache` and `npm cache clean --force` | Provider command | Only the clean command is wired; there is no `npm cache verify` step |
| pnpm | `pnpm store path` and pnpm store commands | Provider command | `pnpm store prune` removes unreferenced packages |

## 10. Git worktree requirements

- Discover repositories only below configured roots, the current directory, or explicit roots.
- Parse NUL-delimited porcelain output so spaces, Unicode, and newlines are safe.
- Protect the main worktree.
- Require a clean status with no untracked files before automatic removal.
- Reject locked worktrees and worktrees containing submodules.
- Detect active use through configured runtime/process evidence where available; unknown activity is a blocker.
- Prefer `git worktree remove <path>` so Git updates administrative metadata.
- Treat `git worktree prune --dry-run` as metadata maintenance, not permission to delete arbitrary directories.
- Re-list and re-check status immediately before removal.
- Report an unregistered directory that resembles a worktree without deleting it.

## 11. Windows requirements

- Normalize drive-letter casing and compare paths case-insensitively.
- Support spaces, Unicode, UNC paths, and long paths.
- Use `lstat`, not `stat`, when deciding whether a path is a link.
- Reject symlinks, junctions, mounts, and unknown reparse points.
- Never use shell command strings for Git or provider commands.
- Use bounded retries for transient sharing violations.
- Do not use `MoveFileEx` reboot deletion in v1.
- Do not kill processes or elevate privileges.
- Provide a diagnostic path for identifying lock owners in a later release, but do not terminate them automatically.
- Exercise these requirements on a real Windows CI runner.

## 12. Plan and execution requirements

A plan is valid only if:

- its schema version is supported;
- its hash matches its contents;
- its roots still resolve within the current policy;
- its provider versions are compatible;
- each candidate revalidates immediately before action.

A run manifest must be written after each candidate result. It must distinguish:

- `deleted`;
- `would-delete`;
- `skipped`;
- `failed`.

The summary must include deleted, skipped, and failed logical bytes. `--strict` exits non-zero when any candidate is skipped or failed. A crash must never result in a final success status without a complete manifest.

## 13. Privacy and security requirements

- No network request is necessary for scanning or cleaning.
- No transcript or prompt content is indexed.
- No credential or raw provider output is printed.
- Plan and manifest files contain metadata only.
- Configuration is user-scoped and does not require administrator access.
- Provider commands are invoked with argument arrays and bounded timeouts.
- All file operations are constrained by canonical path boundaries.
- Unknown ownership is always a blocker.

## 14. Success criteria

The product is ready for an initial release when:

- `npx --package` execution works from a packed tarball on supported platforms;
- `scan` is read-only and produces a valid human-readable and JSON plan;
- `clean --dry-run` performs no mutation;
- normal `clean` requires confirmation;
- non-interactive cleanup requires `--plan --yes`;
- changed candidates are skipped during revalidation;
- dirty, locked, active, and main worktrees are protected;
- symlink and junction escapes are rejected;
- Windows sharing violations are bounded and truthfully reported;
- an interrupted run can be inspected and resumed without repeating successful actions;
- automatic mode cannot select history, credentials, settings, plugins, memory, unknown providers, or undocumented paths;
- provider tests prove protected paths are not candidates;
- Windows, macOS, and Linux CI checks pass;
- the README explains installation, safety, supported providers, automation, privacy, and limitations.

## 15. Release phases

### Phase 1: safe foundation

- package and CLI entrypoint;
- path and filesystem safety core;
- plan hashing and manifests;
- Git worktree provider;
- Claude, Gemini, Cline, OpenCode detection and documented disposable paths;
- npm and pnpm command providers;
- human and JSON output.

### Phase 2: automation

- policy file management;
- `auto --once`;
- Windows Task Scheduler adapter;
- macOS launch agent and Linux systemd user timer adapters;
- status and local result reporting.

### Phase 3: broader diagnostics

- Codex and Cursor detection with maintained path verification;
- diagnostic lock-owner reporting on Windows;
- additional package managers with official prune/verify commands;
- optional project-root `node_modules` analysis.

No later phase may weaken the fail-closed safety rules established in Phase 1.

## 16. Research basis

- Git documents `worktree list --porcelain`, `worktree remove`, locking, pruning, and clean-worktree safeguards.
- Windows documents delayed reboot deletion separately from ordinary deletion; the product deliberately does not use it.
- Claude Code documents application data, retention cleanup, protected configuration, and project purge behavior.
- Gemini CLI documents user/project configuration and project-specific temporary shell history.
- Cline documents global data, sessions, settings, plugins, and `CLINE_DATA_DIR`.
- OpenCode documents Windows data, logs, cache, auth, project storage, and its own uninstall/clear-cache behavior.
- npm and pnpm document integrity-aware cache/store operations that are safer than deleting opaque files directly.

The references used during discovery are maintained in the project README and the implementation plan.
