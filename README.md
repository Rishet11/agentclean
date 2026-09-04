# AgentClean

Fail-closed cleanup for the disk space AI coding tools and Git worktrees leave behind: conversation history, parallel worktrees, package caches, `node_modules`, virtual environments, build output.

It finds it, tells you what each thing costs to get back, and only deletes what you approve.

## Install and first run

```bash
npx --yes agentclean scan
```

Read-only. Nothing is deleted by `scan`, ever. Real output, one machine, one run:

```
25 GB found  ·  4.1 GB safe to clear now

    3.2 GB   Python downloads           downloaded again when needed
    853 MB   JavaScript downloads       downloaded again when needed
    46 MB    build files, src/landing   remade next time you build
    5.2 MB   …esktop/spanishvidya-store remade next time you build
    4.6 MB   build files, dev/voicy     remade next time you build
    + 10 smaller item(s), 5.4 MB

  21 GB left alone  ·  outside your folders, chat history, recently used

  agentclean clean      choose what to remove
  agentclean scan -v    full detail
```

Default output is 15 lines. Warm scan takes about 6 seconds. On the author's own machine, one run of `agentclean clean` freed 14 GB with zero failures across 690 candidates.

To actually remove something:

```bash
npx --yes agentclean clean
```

This opens an interactive checklist, not a single yes/no prompt. Arrow keys (or `j`/`k`) move, space toggles a row, `a` toggles a whole tier, `f` selects only the free tier, `n` clears the selection, enter runs it. A running total updates as you check things. Nothing runs until you hit enter, and you can abort with `q` or Ctrl+C at any point without touching anything.

## What it will never touch

- credentials, tokens, auth databases, provider settings, MCP config, plugins, skills, rules, memory
- the Git main worktree, `.git` administrative data, or a dirty/locked/checked-out-elsewhere worktree
- conversation transcripts and chat history — report-only, always (see below)
- anything reached through a symlink, junction, or unknown reparse point
- anything it can't get positive evidence of ownership for, even if the folder name looks obviously disposable

If it can't prove a path is safe to delete, it leaves it and tells you why, instead of guessing.

## Sort by what it costs to get back, not by size

Every candidate is scored by restore cost, not just bytes. `agentclean scan -v` shows the breakdown:

```
By restore cost:
  Safe to remove          61 MB     11 item(s)     offline, seconds each
  Comes back when needed  18 GB     654 item(s)    needs network or a rebuild step, usually minutes
  Gone for good           6.7 GB    6 item(s)      no way back, review before deleting
```

A 400 MB build folder that rebuilds in 30 seconds and a 400 MB folder with no way back are not the same decision, even though `du` shows them as the same size. AgentClean tells you which one you're looking at and, where it can, exactly what command gets it back:

```
  3.2 GB     [uv] uv cache prune - refills on the next uv install, ~2m
  1.6 GB     [git] git worktree remove ... - git worktree add ... refs/heads/ao/agent-orchestrator-239/root, ~1m
  1.2 GB     [git] git worktree remove ... - 47 commit(s) here are on no remote; they survive removal in the repo. git worktree add ..., ~1m
```

A worktree with unpushed commits is flagged as such rather than silently treated as disposable, but removing it (via `git worktree remove`) doesn't touch those commits — they stay in the repo's object store and the branch survives, only the working copy goes.

## Conversation transcripts are never selectable

`~/.claude/projects`, Codex session history, and similar chat/history directories show up in `scan -v` so you can see how much space they hold — but they are always report-only. There is no flag, no category, no policy setting that makes them deletable. This is a deliberate line, not a missing feature: this tool touches caches and rebuilds, not the record of what you asked an AI to do.

## Providers

`agentclean providers` detects 16 tools and package managers. A tool that isn't installed degrades to `unavailable` — it's skipped, not treated as an error.

```
git          verified     Git worktree metadata available
project      verified     enable with --project-artifacts or a project category
claude       verified     documented data root                          ~/.claude
gemini       verified     documented data root                          ~/.gemini
antigravity  verified     documented data root (shared with gemini-cli) ~/.gemini
cline        diagnostic   no candidate root found
opencode     verified     documented data root                          ~/.local/share/opencode
codex        verified     documented data root                          ~/.codex
cursor       verified     documented data root                          ~/Library/Application Support/Cursor
npm          verified     provider command available
pnpm         verified     provider command available
uv           verified     provider command available
go           verified     provider command available
yarn         unavailable  command unavailable
bun          unavailable  command unavailable
pip          verified     provider command available
```

Cline is currently diagnostic-only: it reports whether it found anything, but never deletes. Nothing about a Cline install has been verified on any machine this was tested on, so it stays inert rather than guessing at a path. Codex and Cursor are fully wired: real detection, real cleanup, revalidated the same way as everything else.

Package caches are cleaned through the package manager's own command (`npm cache clean --force`, `pnpm store prune`, `uv cache prune`), never by deleting store internals directly, because some of these stores are hardlinked into every install on the machine.

## Automatic cleanup

`agentclean auto --once` runs only the safe policy: provider-declared caches past an age threshold, using integrity-aware commands. History, worktrees, and credentials are never auto-eligible.

Scheduling it (`agentclean auto install --interval weekly`) currently works on **Windows only**, via Task Scheduler. macOS launch agents and Linux systemd timers are not built yet — running on those platforms throws a clear error rather than silently doing nothing. If you're on macOS or Linux, run `agentclean auto --once` from your own cron or launchd job in the meantime.

## Is it safe?

**Will this break my projects?** It only deletes things it has positive evidence for: a `node_modules` next to a lockfile, a `.venv` with a `pyvenv.cfg`, a Git worktree confirmed clean via `git status --porcelain`. A folder named `cache` or `temp` is not, by itself, evidence of anything.

**Can I undo it?** For build artifacts, caches, and clean worktrees: yes, by rerunning the tool that made them (`npm ci`, `uv cache prune` refilling on next install, `git worktree add` from the branch that survived). For anything in the "gone for good" tier, no — which is why that tier is never pre-selected in the checklist and always shown with its restore cost as "no way back." There is no quarantine or `agentclean restore` yet; deletion of anything outside the free/cheap tiers is final the moment you confirm it.

**What if I'm on Windows?** It's a first-class target: Windows paths, long paths, and UNC paths are handled, and the tool retries a locked file within a bounded budget instead of forcing it. It won't kill the process holding the file open or elevate privileges — if something's locked, close the app and rerun.

**Why is it asking about worktrees?** Because a Git worktree can hold uncommitted or unpushed work, and a size-based cleaner can't tell a stale checkout from an active one. The main worktree, dirty worktrees, locked worktrees, and worktrees with submodule state are all protected by tests, not just by a comment saying they should be — including a test proving that `git worktree remove` preserves the branch and every commit in the shared `.git`, and separate tests confirming main, dirty, and locked worktrees are never candidates.

## Safety model

Every deletable candidate needs a documented category and positive ownership evidence — a manifest, a lockfile, clean Git status — never just a familiar-looking name. A dedicated test builds a fake home directory with credentials, settings, plugins, and installed extensions under `.claude`, `.codex`, and `.cursor`, ages every one of them past every retention window, and then asserts that the real Claude Code, Codex, and Cursor providers never return any of those paths as candidates.

"Fail-closed" means: if the tool can't prove a path is what it looks like, right now, it skips it and says why, rather than deleting it anyway. Concretely:

1. **Scan** finds candidates without touching anything.
2. **Plan** records paths, evidence, size, age, and a SHA-256 hash over the whole plan.
3. **Review** — you see the exact list before anything runs.
4. **Revalidate** — every candidate is checked again immediately before deletion, in case something changed since the scan.
5. **Execute** one candidate at a time; one failure doesn't turn into a forced delete of the rest.
6. **Manifest** — every result is written to disk, so an interrupted run is still an honest one.

It records metadata to explain and revalidate decisions (path, category, size, timestamps, blockers) but does not index transcript contents, and it does not scrub raw error text everywhere: a failed `git worktree remove`, for instance, records git's own stderr as the failure reason in the run manifest. That's a path or branch name, not a secret, but it is real command output, not a sanitized message — worth knowing if you're piping manifests somewhere you don't fully trust.

## Local development

Requirements: Node.js 20+, Git, npm.

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

133 tests. CI runs typecheck, test, and `pack:check` on Ubuntu, macOS, and Windows, across Node 20 and 22.

## Privacy

Local-first, no network calls required for scanning or cleaning, no telemetry. It records path, category, size, age, and policy metadata to explain and revalidate its own decisions — never transcript content, never credentials, never a full file listing beyond what's needed to size a candidate.

## Project documents

- [`docs/PRD.md`](docs/PRD.md) — product requirements and provider scope.
- [`docs/CURRENT-STATE-AUDIT.md`](docs/CURRENT-STATE-AUDIT.md) — a point-in-time audit; largely historical now, see the note at the top.
- [`docs/IMPROVEMENT-PLAN.md`](docs/IMPROVEMENT-PLAN.md) — the roadmap that audit fed into; also largely historical, see the note at the top.
- [`docs/WHY-NOT-JUST-ASK-AN-AI.md`](docs/WHY-NOT-JUST-ASK-AN-AI.md) — why a deterministic cleaner beats prompting an agent, and how the two are meant to work together.
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
