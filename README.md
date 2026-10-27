# project-starter

`proj`: a Windows-first CLI plus a repo template for private projects worked on by several AI agents at once.
It bootstraps hardened private repos, gives each agent a tracked worktree, keeps handoffs that survive
crashes, verifies work at exact commit SHAs, runs CI once per SHA (drafts cost nothing), profiles and
benchmarks test cost, optionally runs CI on ephemeral self-hosted runners, and cleans up without ever forcing.

Zero dependencies: Node 22+, git, and `gh` (logged in) for the GitHub parts.

## Install

```powershell
gh repo clone trexchery/project-starter "$HOME\project-starter"
npm install -g "$HOME\project-starter"     # links `proj` onto PATH; `proj self-update` pulls later
proj help
```

If `proj` is not found afterwards, your npm prefix is not on PATH (`npm config get prefix`); install into
the standard per-user folder instead: `npm install -g --prefix "$env:APPDATA\npm" "$HOME\project-starter"`.

## Use

```powershell
proj new my-app --stack node --description "what it is"   # private repo, settings, ruleset, CI, agent files
cd my-app
proj task login-form --goal "email+password form" --files "src/auth/**" --issue 12
cd ..\my-app.worktrees\login-form
proj check                       # change-aware tier (falls back to full when impact is uncertain)
proj checkpoint --push --next "wire submit handler"   # backup + draft PR (CI skipped: 0 minutes)
proj check --full                # full suite, recorded against the exact SHA (never rerun for that SHA)
proj ready --wait                # push, mark ready, CI runs once on that SHA, wait for the verdict
cd ..\..\my-app
proj finish login-form --merge   # squash-merge that exact verified SHA, remove worktree, archive branch
proj status                      # implemented / tested / reviewed / CI-verified / released per task
proj doctor --all --report       # stale branches, orphaned worktrees, idle PRs, failing CI, duplicate issues, minutes
proj clean                       # dry run; `--apply` to act
proj perf                        # per-file/job/workflow durations, billed minutes, waste, timeout advice
proj bench                       # measure parallelism/sharding variants (wall + billed minutes) first
proj runner use; proj runner start --docker   # optional: CI on an ephemeral, isolated runner
```

Existing repo: `proj adopt --dry-run`, then `proj adopt` (adds missing files, never overwrites), then
`proj protect --dry-run`, then `proj protect`. Later template improvements:
`proj adopt --upgrade` refreshes only the starter files you never edited.

## What each part guarantees

| Area | Behaviour |
| --- | --- |
| Bootstrap | `git init -b main`, per-repo git config (`pull.ff=only`, `fetch.prune`, `rerere`, `zdiff3`, `core.longpaths`), `.gitattributes` LF, secret-file refusal, private repo, squash-only merges, branch auto-delete, Dependabot alerts + security updates, ruleset `proj-default` (PR required, required check `verify` up to date, no force push/deletion) |
| Plan-aware protection | GitHub enforces rulesets on private repos only on paid plans. `proj protect` records `enforced`, `plan-gated` or `accepted-not-reported`; either way `proj ready`/`proj finish` refuse to merge anything not verified at the exact SHA |
| Agent files | `AGENTS.md` (shared source of truth), `CLAUDE.md` = `@AGENTS.md`, `.claude/settings.json` (secret-read and force/destructive-git denies, hooks), `.claude/agents/` + `.claude/rules/delegation.md` model routing (haiku → sonnet → opus), `.claude/rules/ci.md` scoped rule, `.codex/hooks.json` + `.codex/agents/` |
| Tasks | `proj task` creates a locked worktree on `task/<slug>`, refuses beyond `maxAgents` (3) or `maxOpenPRs` (3), refuses duplicate slugs, issues and open PRs, and refuses overlapping `--files` scopes unless `--allow-overlap` |
| Recovery | `proj checkpoint` (and the Claude/Codex hooks on session start, compaction, session end) snapshots uncommitted + untracked work into `refs/proj/checkpoints/<slug>` without touching files, and writes a compact handoff into the shared git dir. `proj resume --restore` rebuilds a deleted worktree and re-applies that work |
| CI cost | Jobs are skipped on drafts (no runner, 0 minutes) and run on `ready_for_review` at the head SHA. One full run per SHA: a reuse step reports an earlier pass for the same SHA instead of re-testing, `proj ready`/`check --ci` refuse to re-trigger, superseded PR runs are cancelled and same-branch dispatches queue. Heavy suites are `workflow_dispatch` only. A skipped check is never shown as verified |
| Test tiers | `proj check` picks tests from changed files and fails closed to the full suite on manifests, lockfiles, CI/config, shared helpers or unmapped files. `proj ready` needs the full suite (and `checks.heavy` when set) passed on the clean final SHA, locally or with `--remote` |
| Profiling | Every check records duration and per-test-file JUnit timings (`.git/proj/profile.jsonl`); CI uploads `junit.xml` for 7 days. `proj perf` adds job/step durations, billed minutes (OS multipliers; self-hosted and Dependabot free), duplicate and cancelled-run waste, regressions and timeout advice |
| Benchmarks | `proj bench` runs `checks.full`, `bench.variants` and `bench.shardCmd` x `bench.shards`, estimates CI wall-clock and billed minutes (per-job setup, rounding), rejects variants that fail or lose tests, and recommends only one that is faster without raising billed minutes beyond `bench.maxExtraBilled` (25%) |
| Self-hosted CI | Optional. `proj runner use` sets repo variable `PROJ_RUNS_ON`; the CI guard sends only same-repo, non-Dependabot PRs and manual dispatches there. `proj runner start --docker` registers a one-job runner in a capped container (no host mounts, token via env); `--host` needs `runner.allowHost`; `--ddc` uses an already running box. Private repos only. `proj runner use --hosted` switches back |
| External compute | `proj check --remote` / `proj offload` use an already running `ddc` dev box only when `compute.enabled` is set, the host key is pinned, and no secret-looking file would ship. Runtime and workers are capped. It never starts, scales or extends a box |
| Cleanup | `proj clean` is a dry run by default. It deletes only provably merged branches (ancestor, merged PR with identical head, or content already in base), archives each under `refs/proj-archive/` first, never touches dirty, locked, recently active or unmerged work, and never passes `--force` |

## Configuration

Built-in defaults, then `~/.proj/config.json`, then the repo's `.proj.json` (committed). `proj config` prints the
effective values.

```json
{
  "owner": null, "visibility": "private", "defaultStack": "node",
  "maxAgents": 3, "maxOpenPRs": 3, "staleDays": 21, "activeHours": 6,
  "baseBranch": "main", "requiredCheck": "verify",
  "ci": { "monthlyMinutes": 2000, "warnAt": 0.8 },
  "compute": { "enabled": false, "ddc": ["ddc"], "maxRuntimeMin": 30, "maxWorkers": 8 },
  "runner": { "allowHost": false, "cpus": 4, "memory": "8g", "maxMinutes": 60 },
  "heavyBeforeReady": true,
  "checks": { "affected": "node --test {tests}", "full": "npm test", "heavy": null },
  "testGlobs": ["test/**/*.test.js"],
  "bench": { "runs": 3, "setupSecs": 45, "variants": {}, "shardCmd": null, "shards": [2, 4] }
}
```

`proj doctor --schedule weekly` registers a Windows scheduled task (`proj-doctor`, Mondays 09:00) that writes
reports to `~/.proj/reports/`. `--schedule off` removes it.

## Develop proj

`npm test` runs the suite (temp repos, local bare remotes, a fake `ddc`; no network). See `docs/EVIDENCE.md`
for the end-to-end run against a disposable private GitHub repository.
