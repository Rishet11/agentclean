# Improvement plan: making AgentClean useful to humans

**Largely historical.** This was written against the state described in [`CURRENT-STATE-AUDIT.md`](CURRENT-STATE-AUDIT.md) on 2026-09-04. Most of P0 is done — CI exists, the symlinked-root bug and the lockfile check are fixed, exit codes no longer treat a routine skip as failure, project artifacts are visible without a flag, and the four worktree protections have real tests. The restore-cost model, the interactive checklist, and per-provider coverage (P1.1, P1.4, P2.1) are also built and documented in the README. Quarantine/restore (P1.3), cross-platform scheduling (P2.5), and the MCP server (P3.1) are not built yet — those parts of this plan are still current. Read this as a snapshot of what was proposed and check the README and source for what actually landed.

Goal of this document: turn AgentClean from a correct-but-invisible safety engine into something a developer installs, runs, and keeps. It is written to be worked through in order.

The companion documents are [`CURRENT-STATE-AUDIT.md`](CURRENT-STATE-AUDIT.md) for measured facts about the implementation and [`WHY-NOT-JUST-ASK-AN-AI.md`](WHY-NOT-JUST-ASK-AN-AI.md) for positioning.

## 0. The problem with the product today, in one measurement

Measured on a real macOS development machine on 2026-09-04:

| | Size |
| --- | --- |
| `~/.claude` total | 490 MB |
| What AgentClean's Claude provider can currently see | about 1.4 MB (`paste-cache` 192 KB, `session-env` 1.2 MB) |
| `node_modules` under `~/Desktop` alone | 2.2 GB across 8 directories |
| What AgentClean reports for those by default | nothing, project scanning is behind `--project-artifacts` |

So the first run of the tool, on a machine with gigabytes of genuinely reclaimable space, shows the user a couple of megabytes. Everything in the safety model is sound, and none of it matters, because the tool is looking at 0.3% of the problem.

That is the single thing to fix. Not the safety model, the visibility.

## 1. What "useful for humans" means, made testable

Three metrics. If a change does not move one of them, it is not on this plan.

1. **Storage reclaimed per run.** Target: on a working developer machine, the first run surfaces at least 80% of what an expert would find by hand.
2. **Time to first useful answer.** Target: `npx agentclean` with no arguments, no configuration, on a cold machine, produces a ranked, actionable list in under 10 seconds.
3. **Regret events.** Target: zero. Measured concretely as the number of items a user restores from quarantine, which is available locally once quarantine exists.

Metric 3 is the one that justifies the whole fail-closed architecture, and it is currently unmeasurable because nothing can be restored.

## 2. The core product idea: bytes are the wrong unit

Every cleaner in existence sorts by size. Size does not answer the question the human is actually asking, which is not "what is big" but "what can I lose without regretting it."

Give every candidate a **restore cost** alongside its size, and sort by that instead.

```ts
interface RestoreCost {
  tier: "free" | "cheap" | "irreplaceable";
  seconds: number | "unknown";   // estimated time to get it back
  method: string;                // "npm ci", "pip install -r requirements.txt", "git worktree add"
  needsNetwork: boolean;
  confidence: "measured" | "estimated" | "unknown";
}
```

This produces three tiers, which map onto the categories the PRD already defines:

| Tier | Contains | Restore | Default treatment |
| --- | --- | --- | --- |
| **Free** | `dist`, `build`, `.next`, `out`, `target`, `coverage`, `.turbo`, provider caches with a documented rebuild path | Offline, seconds to a minute | Pre-selected. This is the "just take it" tier. |
| **Cheap** | `node_modules`, `.venv`, package manager stores, clean linked worktrees | Network, minutes, deterministic given a lockfile | Shown with the exact per-item restore command and time estimate, selected only by the user |
| **Irreplaceable** | conversation transcripts, history, memory, credentials, settings, unpushed commits in a worktree | Not recoverable | Never selected, never auto-eligible, shown as information only with an explicit label |

Why this matters more than it sounds:

- It gives the user a defensible default. `agentclean clean --free` is a command someone will run without reading, because by construction it cannot cost them anything except a rebuild.
- It gives the safety model a human-legible reason to exist. "Skipped: irreplaceable" is a sentence a user agrees with. "Skipped: not eligible" is not.
- It is the sort order that actually reflects value. A 200 MB `.next` directory that rebuilds in 12 seconds is a better deletion than a 400 MB virtualenv that takes four minutes and a network connection to restore.

Estimating the numbers does not need to be clever to be useful:

- `node_modules`: count top-level packages, check whether the npm or pnpm cache is warm, estimate from a small built-in table. Refine over time by timing actual restores if the user runs them.
- `.venv`: count entries in `site-packages`, check for a `requirements.txt` or `pyproject.toml`, flag as `unknown` if neither exists (no lockfile means it is genuinely not reproducible, which is exactly the sort of thing the user should be told).
- Build output: `unknown` unless the project has a build script, in which case say so.
- Worktrees: seconds, unless `git log @{upstream}..` shows unpushed commits, in which case the tier becomes irreplaceable.

That last rule is worth calling out. A clean worktree is cheap to restore. A clean worktree with unpushed commits is not, and the current implementation does not distinguish them.

## 3. Roadmap

### P0: unbreak visibility

Nothing else on this list matters while the tool under-reports. Each of these is a correctness bug, detail and file references in [`CURRENT-STATE-AUDIT.md`](CURRENT-STATE-AUDIT.md).

- **P0.0 Put the repo under version control and add CI.** It is not currently a git repository. Add GitHub Actions running typecheck, test, and `pack:check` on ubuntu, macos, and windows runners. The PRD names a real Windows runner as a requirement and Windows is the stated primary platform. Ten minutes of work that everything else depends on.
- **P0.1 Fix the silent-empty project scan.** Project root discovery rejects any root reached through a symlinked ancestor, which on macOS means anything under `/tmp` or `/var` returns zero results with no error. This is the currently failing test.
- **P0.2 Stop silently dropping the largest directories.** `measureTree` throws `scan-limit` past 250,000 entries, and every caller swallows the throw and skips the candidate. The directories most worth showing the user are the ones most likely to exceed the cap. Report a lower-bound size and a visible note instead of dropping the row.
- **P0.3 Fix the lockfile evidence check.** It uses an async predicate inside `Array.some`, so it always passes. The README promises positive ownership evidence for `node_modules` and the code does not currently deliver it.
- **P0.4 Make revalidation survive real filesystems.** It currently requires an exact recursive byte and file-count match between scan and execute. On a multi-gigabyte tree, or any tree an editor or watcher touches, this flips to `contents-changed-since-scan` and the item is skipped. A clean that skips everything is indistinguishable from a broken tool. Split identity (device, inode, kind, top-level shape) from size drift, and re-confirm only on material change.
- **P0.5 Fix exit codes.** Any candidate blocked by policy adds to `skippedBytes`, and any non-zero `skippedBytes` returns exit 3. A completely successful run therefore almost always reports failure to a script. Skipped-by-design is not a failure; only `--strict` should escalate it.
- **P0.6 Scan project artifacts by default.** Discovery is read-only. Gating it behind `--project-artifacts` is what makes the first run useless. Keep the flag as a gate on *deletion eligibility* if you want, but never on *reporting*.
- **P0.7 Close the `--yes` review bypass.** `agentclean clean --yes` in an interactive terminal with no `--plan` executes a freshly scanned candidate set with no prompt and no review. The plan file is the centre of the safety story, and this path routes around it. Require `--plan` whenever `--yes` is present.
- **P0.8 Test the four protections the README leads with.** No test currently drives the Git provider against a real repository, so "main, dirty, and locked worktrees are protected" is unproven. One fixture that builds a temporary repo with a main worktree, a clean linked worktree, a dirty one, and a locked one, then asserts which survive `discover`, closes most of the gap. `src/cli.ts` has no coverage at all, which is how P0.7 went unnoticed.

**Acceptance:** on the measuring machine described in section 0, a bare `agentclean scan` reports the 2.2 GB of `node_modules` and does not report an empty set anywhere the user has real reclaimable data.

### P1: the value layer

**P1.1 Restore cost model.** Section 2. Add the field, populate it per provider, sort by it, group output by tier.

**P1.2 First run that works with zero configuration.** Today `npx agentclean` with no arguments and no config scans the current directory and little else. It should discover candidate roots itself: the common development directory names under the home directory, plus any directory already containing a git repository at shallow depth. Read-only discovery of roots is safe; deletion still requires the existing evidence rules.

Target output shape:

```
$ npx agentclean

Scanning 4 roots, 38 projects, 9 providers                          6.2s

  RECLAIMABLE                                                    12.4 GB
    free to rebuild        offline, under a minute each           1.8 GB
    cheap to rebuild       network, about 14 min total           10.6 GB
    irreplaceable          never touched by this tool                0 B

  LARGEST ITEMS
    926 MB  node_modules   agent-orchestrator-fix/frontend   npm ci, ~50s
    576 MB  node_modules   agent-orchestrator/frontend       npm ci, ~40s
    412 MB  .next          faraway/spaceatc/frontend         build, ~25s
    375 MB  node_modules   faraway/spaceatc/frontend         npm ci, ~35s

  LARGE BUT NOT OURS                                     informational
    256 MB  ~/.claude/projects        conversation history
    216 MB  ~/.claude/plugins         installed plugins

  agentclean clean --free      take the 1.8 GB that costs nothing
  agentclean clean             choose interactively
```

Three things in that mock are doing real work: the tier totals, the per-row restore command, and the "large but not ours" section, which tells the truth about where the space went even when the tool will not touch it. A user whose disk is full is better served by an honest pointer than by silence.

**P1.3 Quarantine and restore.** This is the highest-leverage single feature on this list.

- Deleted items move to `<stateDir>/quarantine/<runId>/` with a metadata file recording the original path, size, and provider.
- Use `rename` when the target is on the same device. When it is not, do not silently fall back to copy-then-delete for multi-gigabyte trees; either skip quarantine for that item with a clear warning or require `--no-quarantine`.
- `agentclean restore --last` and `agentclean restore <runId>`.
- Purge on the next run after the retention window, default 7 days.
- **Report this honestly.** Quarantined bytes are not free until purge. The summary must distinguish "reclaimed" from "quarantined, frees in 7 days," and `--no-quarantine` must exist for the user who needs the space now. A counter that overstates what it freed destroys the trust the rest of the design is buying.

Restores are also the ground truth for metric 3. If people restore things, the classifier is too aggressive, and you will know.

**P1.4 Interactive selection.** The current flow is a flat list and a single all-or-nothing y/N prompt covering everything eligible. Replace it with a checklist: arrow keys, space to toggle, grouped by tier, showing size and restore cost per row, running total at the bottom, with the free tier pre-checked. No dependency needed; this is a few hundred lines against raw stdin, and it is the step that converts a scan into a clean.

**P1.5 Speed.** `measureTree` does an `lstat` plus a `realpath` on every single entry, sequentially. On a 100,000 file `node_modules` that is over 200,000 sequential syscalls, and the scan does this for every candidate. Fix:

- `readdir(dir, { withFileTypes: true })` and use the dirent, dropping the per-entry `lstat` and `realpath` entirely.
- Canonicalize the root once, then refuse to descend into any dirent that reports as a symlink. This preserves the no-follow guarantee at a fraction of the cost.
- Bounded concurrency, around 32 parallel directory reads.
- Persist a measurement cache in the state directory keyed by `(dev, ino, mtimeMs)` so repeat scans are close to instant.

Target: under 10 seconds for a full scan of a machine with 40 projects, which is metric 2.

### P2: trust and retention

**P2.1 Provider coverage driven by measurement, not by guessing.** The Claude adapter currently covers `image-cache`, `paste-cache`, `debug`, and `session-env`. On the measured machine those account for about 1.4 MB out of 490 MB. Coverage decisions should start from measured directory sizes on real machines, then work through each large directory and classify it as disposable, irreplaceable, or informational. Reporting an irreplaceable directory's size is valuable on its own and carries no risk.

Also: the Cline, Codex, and Cursor adapters return no candidates under any circumstance and hardcode guessed paths, including a Windows-shaped `AppData/Roaming/Cursor` path resolved under the home directory on every platform. They add rows to the README support table and deliver nothing. Either verify them or remove them from the table until they do something.

**P2.2 `agentclean report`.** Read the run manifests already being written and show cumulative space reclaimed, items restored, and the last run's outcome. The cumulative counter is what makes people keep a cleanup tool installed.

**P2.3 Finish the commands the PRD already specifies.** `doctor` currently dumps JSON rather than checking anything. `config` implements only `root add`, with no retention, category, provider, remove, or show. `explain` requires `--plan` and so cannot explain anything after a plain `scan`. These are all specified in PRD section 7 and are small.

**P2.4 Make the two unimplemented plan invariants real.** Provider versions are never captured, so PRD 12.4's "provider versions are compatible" check has nothing to compare and a plan stays valid across a provider upgrade that changed what a directory means. And manifests are written but never read back, so an interrupted run re-processes everything on the next attempt. Both are small: add a version field to `ProviderDetection` and stop discarding the `--version` output, and have the executor consult the last manifest for the same plan hash before starting.

**P2.5 Real scheduling on macOS and Linux.** `auto install` throws on any non-Windows platform, while the README states launch agents and systemd user timers as supported. Either implement them or correct the README.

### P3: ecosystem

**P3.1 `agentclean mcp`.** An MCP server exposing exactly two tools: a read-only `scan`, and a `propose` that accepts candidate IDs and returns a plan file path. No tool that accepts a path. No tool that deletes without a human or a policy. This is the argument in [`WHY-NOT-JUST-ASK-AN-AI.md`](WHY-NOT-JUST-ASK-AN-AI.md) turned into a feature, and it converts the most common objection into the reason to install.

**P3.2 Publish.** `npx --package` execution from a packed tarball, verified on all three platforms in CI, then npm. Confirm the `agentclean` name is available before committing to it in documentation.

## 4. What not to build

- **No GUI.** The value is in being scriptable and schedulable.
- **No telemetry, no cloud.** Local-first is a differentiator here, not a limitation.
- **No generic disk cleaning.** Do not start deleting Xcode `DerivedData`, Docker volumes, or `~/Library/Caches`. Report them in the "large but not ours" section with the correct command for the user to run themselves. That is genuinely helpful, costs nothing, and does not dilute what the tool is.
- **No new diagnostic-only providers.** They are README rows with no behavior behind them.
- **No process killing, no reboot-time deletion, no privilege escalation.** Already non-goals in the PRD. Keep them non-goals.

## 5. Sequencing

| Phase | Work | Unlocks |
| --- | --- | --- |
| P0 | Repo and CI, five correctness bugs, project scan on by default | The tool reports what is actually on the disk |
| P1 | Restore cost, zero-config first run, quarantine and restore, interactive selection, speed | A person would choose to run it twice |
| P2 | Provider coverage from measurement, report command, doctor/config/explain, cross-platform scheduling | A person keeps it installed |
| P3 | MCP server, publish | Other tools call it, and the AI objection becomes the pitch |

P0 is small and mostly mechanical. P1 is the actual product. Do not start P2 before P1.3 exists, because quarantine is what makes broader provider coverage safe to ship.
