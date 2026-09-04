# Current state audit

**Historical.** This audit was measured on 2026-09-04, before the repo had version control or CI. Most of the P0 findings below (F1, F4, F5, F7 partially, F8, F13, and others) have since been fixed; see [`IMPROVEMENT-PLAN.md`](IMPROVEMENT-PLAN.md) and the README for current status. Kept here as a record of what was found and when, not as a description of the tool today.

Two findings below did not hold up on a later check against the same code path: **F1** (the symlinked-ancestor bug) — `projectRoots()` no longer has this shape, it canonicalizes each directory before recursing into it rather than comparing back to the un-resolved input, and a live run finds and lists project artifacts correctly. And the "1 failed" test count in section 1 — a full run of the current suite (133 tests) passes with zero failures; the failing test this section describes was fixed along with F1.

Measured on 2026-09-04, macOS (Darwin 25.5.0), Node 20+, against the working tree at `~/Desktop/research`.

Everything in this document was observed by running the code or reading it, not inferred. Where something was not verified it says so.

## 1. Repository and build state

| | |
| --- | --- |
| Version | 0.1.0, unpublished |
| Source | 31 TypeScript files, 2,245 lines |
| Version control | **None.** Not a git repository, no history, no CI configuration |
| `npm test` | 12 passed, 1 failed, at the time this was written |
| Failing test | `src/test/project-artifacts.test.ts`, the only test in that file, at the time this was written |

The failure was real at the time and not a flaky test. `ProjectArtifactProvider.discover()` returned an empty set where the fixture expected three candidates:

```
+ actual - expected
+ Set(0) {}
- Set(3) { 'build-artifacts', 'project-dependencies', 'project-environments' }
```

Root cause described in section 3, finding F1. **Since fixed:** the current suite (133 tests) passes in full, and `projectRoots()` no longer has the bug F1 describes — see the note at the top of this document.

## 2. The coverage gap, measured

This is the headline finding. Sizes below are from `du` on this machine.

Boot volume: **228 GB total, 7.9 GB free, 96% full.** This is a machine that genuinely needs the product.

| Location | Measured | What AgentClean does with it today |
| --- | --- | --- |
| `~/.cache/uv` | **9.2 GB** | Nothing. No provider exists. |
| `~/.codex` | **4.6 GB** | Nothing. Codex is a `DiagnosticProvider`, which returns `[]` from `discover()` under all conditions. |
| `~/Library/Caches` | 3.9 GB | Nothing, out of scope by design. |
| `~/.npm` | 2.5 GB | Covered, via `npm cache clean --force`. |
| `node_modules` under `~/Desktop` (depth 4) | 2.2 GB across 8 directories | Only visible with `--project-artifacts`. Not in a default scan. |
| `~/Library/pnpm` | 1.1 GB | Covered, via `pnpm store prune`. |
| `~/go/pkg/mod` | 1.1 GB | Nothing. No provider exists. |
| `~/.claude` | 490 MB | About **1.4 MB** visible (`paste-cache` 192 KB, `session-env` 1.2 MB). `image-cache` and `debug` are not present on this machine. |

Breakdown of the two AI directories the tool claims to support or track:

| `~/.claude` child | Size | | `~/.codex` child | Size |
| --- | --- | --- | --- | --- |
| `projects` | 256 MB | | `logs_2.sqlite` | 705 MB |
| `plugins` | 216 MB | | `plugins` | 365 MB |
| `file-history` | 8.0 MB | | `.tmp` | 366 MB |
| `skills` | 4.8 MB | | `computer-use` | 69 MB |
| `session-env` | 1.2 MB | | `cache` | 62 MB |
| `paste-cache` | 192 KB | | `generated_images` | 36 MB |

Two conclusions:

1. Roughly **15 GB** on this machine sits in locations the tool has no provider for at all, on a disk with 7.9 GB free.
2. For the provider it supports best, it can see 0.3% of the directory.

The safety engineering is not the bottleneck. Coverage and default visibility are.

## 3. Findings

Severity: **S1** breaks the product's core function, **S2** breaks a stated promise, **S3** correctness or maintenance debt.

### F1 (S1) Project scanning returns zero results under any symlinked ancestor — FIXED, did not reproduce

**Update:** rechecked against the current `projectRoots()` in `src/providers/project.ts`. It now calls `safeRealPath(current)` and recurses using the resolved path directly, rather than comparing the resolved path back against the un-resolved input and bailing on a mismatch. The symlinked-ancestor case (`os.tmpdir()` under `/var` resolving to `/private/var` on macOS) no longer aborts the walk. A live `agentclean scan --project-artifacts` run and the current test suite both confirm project artifacts are found normally. Original finding kept below for the record.

`src/providers/project.ts`, `projectRoots()`. The walk calls `safeRealPath(current)` and returns early unless `samePath(resolved, current)`. On macOS, `os.tmpdir()` resolves to `/var/folders/...`, whose real path is `/private/var/folders/...`. The two differ, so the walk aborts at the root and finds nothing.

Impact: silent empty output for any root reached through a symlink, with no error and no warning. This is the failing test. Anywhere a user's projects live behind a symlinked path, the tool reports that there is nothing to clean.

The intent of the check is sound. The implementation conflates "this path is a symlink" with "this path was reached through one." Canonicalize the root once, then enforce no-follow per entry.

### F2 (S1) The largest directories are silently dropped

`src/core/filesystem.ts:36`. `measureTree` throws `scan-limit` once it has walked 250,000 entries. Every call site swallows it:

- `src/providers/filesystem.ts`, `measureTree(target).catch(() => undefined)` then `if (!measured) continue`
- `src/providers/project.ts`, same pattern
- `src/providers/command.ts`, same pattern

Impact: a monorepo `node_modules` or a large package store exceeds the cap, throws, and disappears from the report entirely. The directories most worth showing a user are the ones most likely to be dropped. This is invisible to the user, who cannot distinguish "nothing here" from "too big to count."

Report a lower-bound size with a visible note instead of dropping the candidate.

### F3 (S1) Revalidation will skip almost everything on a real machine

`src/providers/filesystem.ts` and `src/providers/project.ts`, both `revalidate()`:

```ts
const measured = await measureTree(target).catch(() => undefined);
if (!measured || measured.bytes !== candidate.bytes || measured.fileCount !== candidate.fileCount)
  return { ok: false, reason: "contents-changed-since-scan" };
```

This demands exact recursive byte and file-count equality between scan time and execute time, on top of an already-strict `mtime` and `size` fingerprint check on the root.

Impact: for a multi-gigabyte tree, or any tree touched by an editor, a language server, a watcher, or a build in the interval, the item is skipped. Combined with F4 the practical result is a `clean` that reports failure and deletes nothing. A tool that fail-closes on everything is indistinguishable from a broken tool, and users will not read the reason.

It is also a second full recursive walk of every candidate at execute time, which doubles the cost of the slowest operation in the program.

### F4 (S2) A successful run reports failure

`src/cli.ts`, end of `runClean`:

```ts
return result.failedBytes > 0 || result.skippedBytes > 0 ? EXIT_PARTIAL : EXIT_OK;
```

`EXIT_PARTIAL` is 3 (`src/core/errors.ts:3`). Any candidate blocked by policy, including the routine `younger-than-30-days`, adds to `skippedBytes`. So a run that did exactly what it was designed to do exits non-zero.

Impact: every script, CI job, and scheduled task treats normal operation as failure. The PRD reserves this escalation for `--strict` (section 12); the code applies it always.

### F5 (S2) The lockfile evidence check never runs

`src/providers/project.ts`, in both `discover()` and `revalidate()`:

```ts
if (rule.category === "project-dependencies" &&
    (!(await hasFile(root, "package.json")) || !(await packageLocks.some((lock) => hasFile(root, lock))))) continue;
```

`Array.prototype.some` with an async predicate tests the returned Promise for truthiness, and a Promise is always truthy, so `some` returns `true` on the first element. `await true` is `true`, and the negation is always `false`. Only the `package.json` half of the condition has any effect.

Impact: `node_modules` qualifies without any lockfile present. The README states that a provider "is not allowed to delete a path merely because it contains words such as `cache`, `temp`, `session`, or `worktree`" and that "each deletable candidate must have positive ownership evidence." Half of the declared evidence for the largest category of deletion is not being collected.

Correct form: `(await Promise.all(packageLocks.map((lock) => hasFile(root, lock)))).some(Boolean)`.

### F6 (S2) The OpenCode Windows path is the POSIX path

`src/providers/ai.ts`, `opencodeProvider()`:

```ts
(context) => process.platform === "win32"
  ? homePath(".local", "share", "opencode")
  : homePath(".local", "share", "opencode")
```

Both branches are identical, so the ternary is dead and Windows resolves to a POSIX-shaped path. The README names Windows as the primary target and the PRD section 9 requires each provider to "document its exact root."

Not verified: what the correct Windows location is. That needs checking against OpenCode's current documentation before fixing.

### F7 (S2) Scheduling exists on Windows only

`src/platform/scheduler.ts:14,23,29`. `installScheduler` and `uninstallScheduler` throw `"automatic scheduling is not implemented on this platform yet"` on any non-Windows platform, and `schedulerStatus` returns `not implemented`.

The README states: "Windows Task Scheduler; macOS launch agents; Linux systemd user timers, with an explicit cron fallback if requested." Two of those three do not exist. PRD section 15 lists them in Phase 2.

### F8 (S2) Three providers are permanently inert

`src/providers/ai.ts`, `DiagnosticProvider`. `discover()` returns `[]`, `revalidate()` returns `ok: false`, `execute()` returns `ok: false`. Cline, Codex, and Cursor all use it.

Their roots are also hardcoded guesses that are wrong off-platform: `cursorProvider` resolves `homePath("AppData", "Roaming", "Cursor")` on every platform including macOS, where that path does not exist. `DiagnosticProvider.detect` then does a prefix comparison against `context.home` rather than checking whether the path is real, so `root` is reported for a directory that does not exist.

Impact: three rows in the README support table, zero behavior. On this machine that includes the 4.6 GB `~/.codex` directory, the second largest single sink measured.

### F9 (S3) `doctor` does not diagnose

`src/cli.ts`, `runDoctor`. It prints `{ platform, node, cwd, roots, configRoots, providers }` as JSON. PRD section 7 specifies checks of Node.js, Git, provider commands, configured roots, permissions, path capabilities, and scheduler state, returning "actionable but non-destructive messages." None of those checks exist.

### F10 (S3) `config` implements one of its specified operations

`src/cli.ts`, `runConfig` accepts only `config root add <path>`. PRD section 7 also specifies removing roots, configuring retention ages, and configuring automatic categories and providers. The `Policy` type carries `safeCacheAgeDays`, `historyAgeDays`, `worktreeInactiveDays`, `autoCategories`, `autoProviders`, and `worktreeRoots`, and none of them are reachable from the CLI. They can only be changed by editing the config file by hand.

### F11 (S3) `explain` cannot explain a normal scan

`src/cli.ts`, `runExplain` throws unless `--plan <file>` is passed. PRD section 7 says explain should "resolve a candidate from the current plan or run manifest." A user who ran a plain `agentclean scan` has no plan file and therefore cannot use `explain` at all, which removes the main path by which a user builds confidence before deleting.

### F12 (S3) Measurement is syscall-bound and sequential

`src/core/filesystem.ts`, `measureTree`. Per entry it performs an `lstat` and a `safeRealPath`, awaited one at a time, recursing depth-first with no concurrency. For a 100,000 file tree that is over 200,000 sequential syscalls, and `realpath` is the more expensive of the two.

This runs for every candidate at scan time, and again for every candidate at revalidate time (F3). Not benchmarked here, but it is the dominant cost in the program and it is the reason metric 2 in the improvement plan (under 10 seconds to first answer) is currently out of reach.

`readdir` with `withFileTypes` supplies the type without an `lstat`, and canonicalizing the root once removes the per-entry `realpath` while preserving the no-follow guarantee.

### F13 (S3) Project artifact discovery is off by default

`src/core/context.ts:6`, `allowProjectArtifacts` defaults to `false`, and `src/providers/project.ts`, `discover()` returns `[]` immediately when it is unset.

Discovery is read-only, so this gate protects nothing. It only ensures that the default first run hides the largest category of reclaimable space, which on this machine is 2.2 GB on the Desktop alone.

### F14 (S3) Minor

- `writeOutput(value, options)` in `src/cli.ts` never reads `options`.
- The confirmation prompt reads `Delete N approved item(s)`, but the eligible set can include `provider-command` candidates, which are not deletions.
- `runScan`'s `autoOnly` parameter is declared and never passed a non-default value.
- `src/core/scan.ts` runs providers sequentially in a `for` loop; they are independent and could run concurrently.

## 4. Additional findings from a full PRD-versus-code sweep

A second pass walked every bullet requirement in PRD sections 7, 9, 10, 11, 12, 13, and 14 against the implementation. Headline count across those sections: roughly 45 requirements met, 25 partial, 14 missing, 3 contradicted.

Items below marked **verified** were re-checked directly against the source. The rest are reported as found and still need confirmation.

### F15 (S1) `clean --yes` deletes an unreviewed scan with no confirmation (verified)

`src/cli.ts:99-103`:

```ts
if (!autoOnly && !options.yes) {
  if (!(await askConfirmation(eligible.length))) return EXIT_OK;
} else if (!autoOnly && !options.plan && (!stdin.isTTY || !stdout.isTTY)) {
  throw new Error("non-interactive cleanup requires --plan <file> --yes");
}
```

Run `agentclean clean --yes` in an interactive terminal with no `--plan`. The first branch is false because `options.yes` is set. The second is false because both streams are TTYs. Execution falls straight through to `executePlan`.

The result is that a freshly scanned candidate set that no human has ever looked at gets deleted with no prompt and no plan file. PRD section 7 requires "both `--plan` and `--yes` for non-interactive execution," and success criterion 14.4 requires confirmation for a normal clean. The review step is the centre of the whole design, and this path skips it.

Treating `--yes` as "skip the prompt" is a normal CLI convention, so this may read as intentional. It is not compatible with this product's stated contract: the point of the plan file is that something was reviewed before anything was deleted. Either require `--plan` whenever `--yes` is present, or make `--yes` alone print the plan and require a second explicit flag.

Related: `src/cli.ts` has no test coverage at all, which is why this went unnoticed.

### F16 (S2) Provider versions are never captured, so a documented safety check cannot work

PRD 12.4 makes a plan invalid if "its provider versions are compatible" fails, and PRD 9.4 requires each provider to "report the provider version or source version used for the decision."

`ProviderDetection` in `src/core/types.ts:38-45` has no version field. `src/providers/command.ts:15-16` runs `<tool> --version`, checks the exit code, and discards the output. `src/core/executor.ts:16` compares only the set of provider IDs.

Impact: a plan saved before a provider upgrade, where the upgrade changed what a directory means, will still validate and execute. This is the one documented invalidation rule that has no implementation behind it.

### F17 (S2) Interrupted runs are not resumable

PRD 14.10 requires that "an interrupted run can be inspected and resumed without repeating successful actions."

Manifests are written after every candidate (`src/core/executor.ts`), so the inspection half works and works well. Nothing reads them back. A rerun after an interruption re-processes every candidate from the start. `src/core/manifest.ts` exports `latestManifest`, which is never imported anywhere.

### F18 (S3) Raw command stderr reaches manifests and the terminal

`src/providers/git.ts:129` (verified):

```ts
return result.code === 0 ? { ok: true, bytes: candidate.bytes }
                         : { ok: false, bytes: 0, reason: result.stderr.trim() || `git exited ${result.code}` };
```

That `reason` is stored in the run manifest. `src/platform/scheduler.ts:19,25` similarly throw raw `schtasks` stderr, which `src/cli.ts` prints.

The README states the tool does not "include raw provider command output in normal reports." In practice the leaked content is paths and branch names rather than credentials, so the severity is low, but the claim as written is not true. Either sanitize to a fixed set of reasons and keep the raw text behind a verbose flag, or soften the README.

### F19 (S3) Worktree activity detection is absent and two policy fields are dead

PRD 10.6 requires detecting active use of a worktree through runtime or process evidence, treating unknown activity as a blocker. `src/providers/git.ts` implements a `current-directory` check and nothing else.

`Policy.worktreeInactiveDays` and `Policy.worktreeRoots` (`src/core/types.ts`) are validated by `src/config/store.ts` and then never read by any consumer. They are configuration surface with no effect.

Also missing from section 10: `git worktree prune` is never invoked (10.8), and there is no detection of an unregistered directory that resembles a worktree (10.10).

### F20 (S3) No defense in depth at execute time

`src/providers/filesystem.ts` and `src/providers/project.ts` both call `removeTree(candidate.target.path)` in `execute()` without re-checking root containment. Containment is enforced in `revalidate()` immediately before, so this is not currently exploitable, but it means a single missed check in one provider's revalidate becomes an unbounded delete. `validateTarget` exists in `src/core/filesystem.ts:87` and is not called from any execute path.

For a tool whose entire pitch is fail-closed, the final `rm` should re-assert the boundary itself rather than trusting its caller.

### F21 (S2) README overclaims

| Claim | Reality |
| --- | --- |
| "pnpm: Yes, when explicitly enabled" | `defaultPolicy.autoProviders` includes `pnpm`, the pnpm candidate sets `autoSafe: true`, and `store.ts` falls back to `defaultPolicy` when no config file exists. `pnpm store prune` is auto-eligible on a fresh install with no explicit step. Verified. |
| "Claude Code / OpenCode: No until policy is explicitly enabled" | Both appear in `defaultPolicy.autoProviders`, which reads as a contradiction, but every `DisposableRoot` for them sets `autoSafe: false` and `policyAllowsAuto` checks `autoSafe` first. Behavior matches the README; the default config is misleading but inert. Worth cleaning up so the two do not have to be read together to know the answer. Verified. |
| "macOS launch agents; Linux systemd user timers" | Windows only. See F7. |
| "does not include raw provider command output" | See F18. |
| "positive ownership evidence" for project artifacts | See F5. |
| `npm test` presented as a working dev loop | Was 1 failing test at the time of this audit (section 1). Since fixed: the current suite (133 tests) passes in full. |

### F22 (S2) Test coverage does not cover the safety claims

The tests that exist are good, and they test the wrong layer. `src/test/git.test.ts` tests `parseWorktrees` as a string parser; no test drives `GitWorktreeProvider.discover` or `revalidate` against a real repository. So the four protections the README leads with are unproven:

| Invariant | Proven by a test? |
| --- | --- |
| Main worktree protected | No |
| Dirty worktree protected | No |
| Locked worktree protected | Parsing only, not the blocking logic |
| Symlink or junction escape rejected | Yes, `paths.test.ts:20-28` |
| Plan hash mismatch refused | Yes, `plan.test.ts`, `executor.test.ts:45-50` |
| Dry run never mutates | Yes, `executor.test.ts:52-80` |
| Real provider revalidation rejects a changed candidate | No, only a fake provider is exercised |
| Credentials never become candidates | Only against a synthetic provider, never `claudeProvider()` or `opencodeProvider()` |
| Non-interactive clean requires `--plan --yes` | No, and F15 is the consequence |
| `--strict` escalates on skip or fail | No test sets `strict: true` |

Adding a temporary-repo fixture that creates a main worktree, a clean linked worktree, a dirty one, and a locked one, then asserts which of them survive `discover`, would close most of this in one file.

### Note on F3

The same exact-byte-equality problem applies to `src/providers/git.ts:120-121`, not just the filesystem and project providers. Worktree removal is subject to it too, which means an active worktree, the most common thing a developer wants cleaned up, is among the most likely to be skipped.

## 5. What is solid

Worth stating plainly, because the list above is long and the foundation is not the problem.

- The plan model is genuinely good. Stable sort, canonical serialization, SHA-256 over the body, and `verifyPlan` refusing a tampered file.
- `executePlan` checks policy hash, platform, home, provider set, and root containment before doing anything, and refuses to execute an eligible candidate from a non-verified provider.
- The manifest is persisted after every single candidate, so an interrupted run stays truthful.
- The provider interface is the right shape: `detect`, `discover`, `explain`, `revalidate`, `execute`, with revalidation owned by the provider rather than the executor.
- Delegating package cache cleanup to `npm cache clean` and `pnpm store prune` rather than deleting store internals is the correct call and is the kind of detail that separates this from a generic cleaner.
- `removeTree` re-checks for a reparse point immediately before `rm` and refuses with `force: false`.

The architecture supports the improvements in [`IMPROVEMENT-PLAN.md`](IMPROVEMENT-PLAN.md) without redesign. The work is coverage, defaults, speed, and calibrating the fail-closed rules so they block real risk rather than routine filesystem activity.
