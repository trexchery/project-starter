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
| Self-hosted CI | `proj runner use` adds a repo to `proj runner serve`, which routes same-repo PRs not opened by bots to one-job runners; `proj runner start --docker` starts one in a capped container (single-use JIT config on stdin, all capabilities dropped). `proj runner serve` keeps a docker pool ready for every served repo (below); `proj runner hosted` moves them all to GitHub-hosted. Private repos only |

## Self-hosted runner pool (`proj runner serve`)

Opt in per machine in `~/.proj/config.json` (a repo's `.proj.json` cannot):

```json
{ "runner": { "serve": { "repos": [], "slots": 3, "pool": 1, "cpus": 4, "memory": "8g", "pollSec": 60, "idleMinutes": 20, "maxMinutes": 60 } } }
```

- With `runner.serve` present, `proj new` adds every new **private** node or python repo to `repos` (public repos
  never). `proj runner use` / `use --hosted` adds or removes an existing repo. Only serve sets `PROJ_RUNS_ON`, after a
  heartbeat and only while it runs (its next repo check, within about 15 minutes), so a repo is never routed to a
  machine that is off. Generic-stack repos stay GitHub-hosted: their CI runs `pwsh`, which the runner image
  (`ghcr.io/actions/actions-runner`) does not ship.
- Every `pollSec` serve lists each repo's runners (one API call per repo; under 300 calls an hour for 3 repos) and
  starts `pool - idle` ephemeral containers, never more than `slots` at once (`slots` x `cpus` x `memory`),
  counting containers it spawned that `docker ps` does not list yet. The image is pulled once before the first
  start. Each runner registers with a single-use JIT config handed over on stdin, runs one job, and is removed.
- An unused pool runner is unregistered and stopped after `idleMinutes` (never one holding a job: GitHub refuses
  the unregister). A container's hard stop is `idleMinutes + maxMinutes + 10` minutes from its start, so a job
  picked up late still gets `maxMinutes` (set it to your longest job; the job's own `timeout-minutes` applies too).
  Offline registrations that this serve process started are deleted (never another machine's, and never one from
  `proj runner start`; `proj runner clean` removes leftovers). Containers are stopped with `docker stop` (they run
  with `--rm`), and every docker call times out after 20 seconds (docker counts as down for that poll).
- A repo that becomes public, archived, deleted (not found) or leaves `repos` gets `PROJ_RUNS_ON` deleted and its
  idle containers unregistered and stopped; a runner holding a job finishes it. A failed repo check (rate limit,
  network) never drops a repo.
- Fallback to GitHub-hosted (serve deletes `PROJ_RUNS_ON`, cancels runs whose jobs waited over 5 minutes on
  `proj-ephemeral`, and re-runs them, since runs-on is evaluated at queue time) when `docker version` fails two
  polls in a row, when a proj job waited over 5 minutes while a slot was really free and no runner of its repo was
  idle or starting (a run with a proj job in progress never counts and is never cancelled), or after two started runners in a
  row never came online (failed starts also back off, up to 30 minutes). Healthy again (and at least 30 minutes
  after a stuck-job or failed-start fallback), serve sets `PROJ_RUNS_ON` back. Cancelled runs are re-run either
  way. Stopping serve (Ctrl+C, SIGTERM) also switches CI to GitHub-hosted; the next start switches it back.
- `proj runner serve --once --dry-run` prints what one poll would do without starting or changing anything.

Run it from a dedicated worktree pinned to `main`, so branch switches in your working checkout never change the
code that serves CI (PowerShell 7.3 or later, which quotes the `/TR` value for schtasks; nothing below runs unless
you run it):

```powershell
git -C $HOME\project-starter fetch origin
git -C $HOME\project-starter worktree add --detach $HOME\.proj\serve-main origin/main
$tr = '"{0}" "{1}" runner serve' -f (Get-Command node).Source, "$HOME\.proj\serve-main\bin\proj.js"
schtasks /Create /TN "proj runner serve" /SC ONLOGON /RL LIMITED /F /TR $tr
schtasks /Run /TN "proj runner serve"
# update later: git -C $HOME\.proj\serve-main fetch origin; git -C $HOME\.proj\serve-main checkout --detach origin/main
#               then schtasks /End /TN "proj runner serve"; schtasks /Run /TN "proj runner serve"
```

`schtasks /End` kills the process without a signal, so CI stays routed to self-hosted until serve runs again: run
`proj runner hosted` to move every served repo to GitHub-hosted now (they stay in `repos`; serve switches them back
when it runs).

PC off, asleep or serve killed: serve writes the repo variable `PROJ_RUNS_ON_HEARTBEAT` (unix time) every 5
minutes while CI is routed here (and right after its first image pull), sets `PROJ_RUNS_ON` again with each one (so
a deletion by the watchdog is undone within 5 minutes once serve is alive again), and the optional [runner watchdog](runner-watchdog.yml) (every 15 minutes, about 10
seconds on `ubuntu-latest`) deletes `PROJ_RUNS_ON` and re-runs proj-queued runs when that heartbeat is over 10
minutes old. Nothing installs it. To use it, copy it to `.github/workflows/` of one repo and add two Actions
secrets there: `PROJ_WATCHDOG_REPOS` (the served repos, space separated; masked in logs) and `PROJ_WATCHDOG_TOKEN`
(a fine-grained token for those repos with Variables: read and write, Actions: read and write). A **public** repo
runs it for free; in a private repo every run bills one minute (about 2,900 a month at this schedule, so use a
slower cron there). GitHub pauses schedules in a public repo after 60 days without activity. Without the
watchdog, queued proj jobs wait until serve is back (GitHub drops them after 24 hours).

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
  "runner": { "allowHost": false, "cpus": 4, "memory": "8g", "maxMinutes": 60, "serve": null },
  "checks": { "affected": "node --test {tests}", "full": "npm test", "heavy": null },
  "testGlobs": ["test/**/*.test.js"]
}
```
