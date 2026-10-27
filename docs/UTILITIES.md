# Optional utilities

Nothing here is needed to create or work on a project. These are helpers for people who want them.

## Task workflow (`proj new --tasks` installs the session hooks)

```powershell
proj task login-form --goal "email+password form" --files "src/auth/**" --issue 12
cd ..\my-app.worktrees\login-form
proj check                       # change-aware tests (falls back to the full suite when impact is unclear)
proj checkpoint --push --next "wire submit handler"   # backup + draft PR (CI skipped: 0 minutes)
proj check --full                # full suite, recorded against the exact commit (never rerun for that commit)
proj ready --wait                # push, mark ready, CI runs once on that commit, wait for the verdict
cd ..\..\my-app
proj finish login-form --merge   # squash-merge that exact verified commit, remove worktree, archive branch
proj status                      # implemented / tested / reviewed / CI-verified / released per task
```

| Area | Behaviour |
| --- | --- |
| Tasks | `proj task` creates a locked worktree on `task/<slug>`, refuses beyond `maxAgents` (3) or `maxOpenPRs` (3), refuses duplicate slugs, issues and open PRs, and refuses overlapping `--files` scopes unless `--allow-overlap` |
| Recovery | `proj checkpoint` (and the Claude Code / Codex hooks on session start, compaction and session end) snapshots uncommitted and untracked work into `refs/proj/checkpoints/<slug>` without touching files, and writes a compact handoff. `proj resume --restore` rebuilds a deleted worktree and re-applies that work |
| Merging | `proj finish --merge` merges only a commit CI verified (a skipped check never counts), with `--match-head-commit`, then removes the clean worktree and archives the branch under `refs/proj-archive/` |

## Verification and CI cost

| Area | Behaviour |
| --- | --- |
| Test tiers | `proj check` picks tests from changed files and their importers, and fails closed to the full suite on manifests, lockfiles, CI/config, shared helpers or unmapped files. `proj ready` needs the full suite (and `checks.heavy` when set) on the clean final commit |
| One run per commit | CI templates skip drafts (no runner, 0 minutes), run on `ready_for_review`, cancel superseded runs, and reuse an earlier pass of the same workflow for the same commit |
| Profiling | `proj perf`: per-test-file timings (JUnit), job and step durations, billed minutes (OS multipliers; self-hosted and Dependabot free), duplicate and cancelled-run waste, regressions and timeout advice |
| Benchmarks | `proj bench` measures `bench.variants` and `bench.shardCmd` x `bench.shards`, estimates CI wall-clock and billed minutes, and recommends only a variant that passes, keeps every test and does not raise billed minutes beyond 25% |
| Self-hosted CI | `proj runner use` routes same-repo PRs not opened by bots to one-job runners; `proj runner start --docker` starts one in a capped container (token on stdin, all capabilities dropped). Private repos only |

## Remote compute

`proj check --remote` and `proj offload "<command>"` run checks on a machine you already have, only when you enable
it in `~/.proj/config.json` (a repo's `.proj.json` cannot):

```json
{ "compute": { "enabled": true, "ssh": "me@build-box" } }
```

or with your own tool that runs a script remotely and forwards stdin: `"command": ["mytool", "run"]`. ssh runs with
strict host-key checking. Secret-looking files are never shipped, and runtime and workers are capped. proj never
starts, rents or stops machines.

## Upkeep

`proj doctor [--all] [--report] [--json]` lists stale or merged branches, orphaned worktrees, idle or failing PRs,
duplicate issues, outdated dependencies and Actions minutes. `proj clean` is a dry run; `--apply` deletes only
provably merged branches, archived first, never dirty, locked, recent or unmerged work, never with `--force`.
`proj doctor --schedule weekly` registers a weekly local audit. In Claude Code, `/project-starter:proj-audit` runs
the same checks and answers in five lines.

## Configuration

Built-in defaults, then `~/.proj/config.json`, then the repo's `.proj.json`. `proj config` prints the result.

```json
{
  "owner": null, "visibility": "private", "baseBranch": "main", "requiredCheck": "verify",
  "maxAgents": 3, "maxOpenPRs": 3, "staleDays": 21, "activeHours": 6,
  "ci": { "monthlyMinutes": 2000, "warnAt": 0.8 },
  "compute": { "enabled": false, "ssh": null, "command": null, "maxRuntimeMin": 30, "maxWorkers": 8 },
  "runner": { "allowHost": false, "cpus": 4, "memory": "8g", "maxMinutes": 60 },
  "checks": { "affected": "node --test {tests}", "full": "npm test", "heavy": null },
  "testGlobs": ["test/**/*.test.js"]
}
```
