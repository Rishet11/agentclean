# Why not just ask an AI to clean the disk?

This is the first question anyone will ask about AgentClean, and it deserves a real answer rather than a defensive one. The short version:

> Asking a model to delete files is asking a non-deterministic system to perform an irreversible action with no audit trail and no undo. The judgment part of cleanup is a good job for a model. The deleting part is not.

AgentClean is not competing with the agent. It is the thing the agent should be calling.

## 1. The objection, stated at full strength

A reasonable developer says:

> I already have a coding agent with shell access. I can type "my disk is full, find the big directories and clean up anything I do not need." It will run `du`, it will read my project layout, it will understand context that a fixed tool never could, and it will do it today without me installing anything. Why would I add a CLI for this?

Every part of that is true. It is also how people will actually lose work.

## 2. Where the objection is correct

Be honest about this up front, because the design depends on it.

- **Models are good at classification.** "This repo has not been touched in eight months, you probably do not need its dependencies installed" is a judgment call, and it is exactly the kind of judgment a model makes well.
- **Models handle the long tail.** AgentClean will never ship an adapter for every tool that writes to your home directory. A model can look at an unknown 4 GB directory and make a decent guess about what it is.
- **Models need no configuration.** No roots to register, no policy file, no provider matrix.

So the answer is not "a model cannot do this." The answer is that a model is the wrong thing to hold the delete permission.

## 3. Where it breaks

### 3.1 The blast radius is unbounded and the undo does not exist

A shell agent deleting files has the whole filesystem in reach. It does not need to be wrong often. It needs to be wrong once: an unset variable that expands to nothing inside a path, a glob that matches one level higher than intended, a directory whose name looks disposable and is not. There is no confirmation step that scales, because by the time the human is reviewing the twelfth `rm -rf` of the session they are pressing yes without reading.

AgentClean's executor structurally cannot exceed its allowlist. Paths are canonicalized, checked against permitted roots, rejected if they are symlinks or junctions, and revalidated immediately before the action. A bug in a provider produces a skipped candidate, not a deleted home directory.

### 3.2 Name matching is not ownership evidence

A model reading a directory listing is pattern matching on names. That fails in specific, predictable ways:

| It sees | It concludes | It can be |
| --- | --- | --- |
| `env/` | Python virtualenv | a config directory, or an environment fixture directory |
| `dist/` | build output | a vendored artifact that is committed and not reproducible |
| `cache/` | disposable | a cache whose loss triggers a multi-gigabyte re-download |
| `.claude/projects/` | project scratch data | your conversation history and the memory you depend on |
| `worktrees/` | stale checkouts | a worktree with uncommitted work in it |

AgentClean's rule is that a folder never qualifies because of its name. `node_modules` needs a `package.json` and a lockfile beside it. A `venv` needs a `pyvenv.cfg` inside it. A worktree needs `git worktree list --porcelain` to call it linked and `git status --porcelain=v2` to call it clean. No evidence, no action, and the tool says so out loud.

### 3.3 There is state a model cannot see from a directory listing

- Is that worktree dirty, locked, or currently checked out by a running process?
- Is that `.venv` the interpreter your running dev server is holding open?
- On Windows, is there an open file handle that will turn the delete into a partial delete, leaving a broken tree that looks cleaned?
- Is that package store hardlinked into every `node_modules` on the machine, so that removing it corrupts installs that currently work?

These are answered by tool-specific probes, not by inference. AgentClean runs the probes.

### 3.4 No plan, no diff, no proof

Ask the same model the same cleanup question twice and you get two different deletion sets. There is nothing to review before it runs and nothing to point at afterwards.

AgentClean emits a schema-versioned plan with a SHA-256 hash over its contents. You can read it, diff it, commit it, send it to a colleague, and execute it later, and the tool will refuse to run it if the policy, platform, provider set, or the candidates themselves have changed since it was written. After the run there is a manifest that records every item as deleted, would-delete, skipped, or failed, with a reason. That is the difference between an action and an auditable action.

### 3.5 You cannot schedule an agent

Most of the value of storage hygiene comes from it happening without anyone thinking about it: weekly, in the background, forever. Nobody should put an autonomous agent with delete permission over their home directory on a 3am timer. A deterministic binary bounded by a hashed policy is precisely the thing you can put on a timer.

### 3.6 Cost, latency, and the fact that it is not cached

Walking a home directory produces a large amount of text. Feeding that to a model and asking it to reason about every directory costs tokens and minutes on every single run, and the conclusion is thrown away afterwards. A bounded filesystem walk costs nothing and finishes in seconds. On a metered plan, "ask the agent to clean up" is a recurring bill for an answer you already had.

### 3.7 The correct operation is often not a delete

`rm -rf` on a pnpm store looks like it frees several gigabytes. It also breaks every hardlinked `node_modules` on the machine. The correct operation is `pnpm store prune`. The same is true for `npm cache verify`, for `git worktree remove` versus deleting the directory and leaving Git's administrative metadata dangling, and for provider tools that ship their own cache-clear command.

There are dozens of these facts. A model has to recall the right one, under pressure, every time. AgentClean encodes each one once, as a provider adapter, with a test.

## 4. The asymmetry that settles it

Reclaiming 3 GB is worth a few cents of disk. Losing an uncommitted branch, an auth token, or a week-old experiment costs hours or days.

The payoff is wildly asymmetric, so the correct tool for this job is loss-averse rather than throughput-optimized. That is why AgentClean is fail-closed, and why "it left some space on the table" is a feature and not a bug. A cleaner that reclaims 90% of the recoverable space and has never destroyed anything beats one that reclaims 100% and occasionally does.

## 5. The resolution: separation of powers

Do not argue that the agent should be kept away from cleanup. Give it the safe half of the job.

**The agent is the brain.** It runs `agentclean scan --json`, gets a list of candidates that the tool has already vouched for with ownership evidence, sizes, ages, and rebuild costs, and applies the judgment it is actually good at: which projects are dead, which caches this user genuinely will not need again, what to recommend first.

**AgentClean is the hands.** It performs discovery, evidence collection, revalidation, bounded execution, and the manifest. It will only act on candidates it generated itself.

The agent cannot invent a path. It can only select from an allowlist the tool produced. The worst case for a hallucinating model becomes "it suggested deleting a cache you wanted," which a confirmation step catches, rather than "it deleted your work," which nothing catches.

Concretely this means shipping:

- `agentclean scan --json` as a stable, documented contract (already the intended shape).
- `agentclean clean --plan <file> --yes` so a reviewed selection can be executed non-interactively.
- `agentclean mcp`, an MCP server exposing exactly two tools: a read-only `scan` and a `propose` that returns candidate IDs. No tool that takes a path as input. No tool that deletes without a plan.

That last one is the product's real position:

> AgentClean is what makes "let my agent clean up my disk" a safe sentence.

## 6. How it compares

| | Ask a shell agent | Generic cleaner app | Manual `du` and judgment | AgentClean |
| --- | --- | --- | --- | --- |
| Knows AI tool storage layouts | Partly, from guessing | No | Only what you know | Yes, per provider |
| Acts on ownership evidence | No | No | Yes, if you are careful | Required |
| Reproducible, reviewable plan | No | No | No | Hashed plan file |
| Refuses when uncertain | Rarely | No | Depends on you | Always |
| Understands dirty or locked worktrees | No | No | Yes, slowly | Yes |
| Uses integrity-aware package commands | Sometimes | No | If you know them | Yes |
| Safe to schedule unattended | No | Partly | No | Yes, policy-bounded |
| Cost per run | Tokens and minutes | Licence fee | 30 to 60 minutes of your time | Seconds, free |
| Audit trail afterwards | No | No | No | Run manifest |

## 7. What the human actually buys

The storage is the visible win. The time is the real one.

Doing this by hand means `du -sh * | sort -rh`, then repeating it a level down, then deciding directory by directory whether each one is safe, then remembering the right prune command for each package manager. That is thirty to sixty minutes the first time, and the reason it does not happen a second time is that nobody wants to spend the hour again.

The target for AgentClean is a ten second scan and a checklist, where every row already carries the two facts a human needs in order to decide: how much space it frees, and what it costs to get it back.

## 8. Objections we do not have a good answer to yet

Keeping this section honest is part of the point.

- **For many people `du -sh * | sort -rh` and a bit of care is genuinely enough.** AgentClean has to be dramatically faster and safer than that, or it is not worth installing. It does not currently clear that bar. See `IMPROVEMENT-PLAN.md`.
- **Fail-closed has a failure mode of its own.** A tool that skips almost everything is indistinguishable from a broken tool. The current revalidation rules skip too aggressively on large or active trees, which is a correctness problem dressed as a safety feature.
- **Provider coverage is the whole product, and it is thin.** A cleaner that can see 1.4 MB of a 490 MB directory has not earned the user's trust regardless of how carefully it deletes that 1.4 MB.
- **The undo story is missing.** Fail-closed builds trust before the action. Quarantine and restore build it after, and people clean far more aggressively when they know they can put it back.

## Related documents

- [`IMPROVEMENT-PLAN.md`](IMPROVEMENT-PLAN.md) for what to build next and in what order.
- [`CURRENT-STATE-AUDIT.md`](CURRENT-STATE-AUDIT.md) for the measured state of the implementation today.
- [`PRD.md`](PRD.md) for the product requirements.
