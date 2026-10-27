# Evidence: end-to-end run, 2026-10-27

A disposable private repository created by `proj new` (private, so its run links are not public).
Everything below was observed, not assumed. SHAs are exact.

## 1. Bootstrap (`proj new proj-e2e-20261027 --stack node`)

- Private repo created; settings read back: `allow_squash_merge=true, allow_merge_commit=false,
  allow_rebase_merge=false, delete_branch_on_merge=true, private=true`. Dependabot alerts + security updates on.
- Ruleset `proj-default` created; `GET rules/branches/main` reported `deletion, non_fast_forward,
  required_linear_history, pull_request, required_status_checks` -> `branch protection: enforced`.
- Enforcement probed for real: a direct `git push origin main` was rejected with
  `Required status check "verify" is expected ... push declined due to repository rule violations`.

## 2. Draft PRs cost nothing; ready runs once on the exact SHA

- PR #1 opened as a draft by `proj checkpoint --push`. CI run 40583707723 on `fa4e5ab95d`: conclusion
  `skipped`, no job started (0 runner minutes). `proj status` showed `ci@sha: skipped`, not verified.
- `proj ready` refused until `proj check --full` had passed at that SHA, then marked the PR ready.
- Superseded run cancelled: run 40583980395 on `dea8d43c55` -> `cancelled` when `7f3c6a296e` was pushed;
  run 40583986197 on `7f3c6a296e` -> `success`. `proj status`: `ci@sha verified`, `tested no` (the local
  full suite had run on the older SHA, and status says so).
- `proj finish greet --merge` merged with `--match-head-commit 7f3c6a296e` -> squash commit `4da2b7a`.

## 3. Interruption recovery with real Claude Code hooks

- `claude -p` (Claude Code 2.1.312) started in the task worktree quoted the injected handoff:
  `Next: run full suite, then ready` / `Branch: task/greet @ fa4e5ab95df5...` (SessionStart hook).
- Uncommitted edit + untracked file, then a Claude session ended: the SessionEnd hook wrote snapshot
  `refs/proj/checkpoints/greet = c7f1455` (both files) without touching the working tree.
- The worktree directory was deleted. `proj resume greet --restore` recreated it and restored
  ` M src/index.js` and `?? NOTES-wip.md` with their exact contents.

## 4. Safe cleanup

- `proj finish` from inside the worktree refused (Windows cannot delete a directory in use).
- With another process holding the worktree as its cwd, `proj finish --abandon` refused with
  "in use by another process ... nothing was removed" (rename probe before any deletion).
- After merges: worktrees removed without `--force`, branches archived under `refs/proj-archive/`
  before deletion, main fast-forwarded. `proj clean` listed 2 merged probe branches (dry run), `--apply`
  deleted exactly those 2 after archiving them.

## 5. CI efficiency (PR #3, template upgrade via `proj adopt --upgrade`)

- `proj adopt --upgrade` in a task worktree: added 2 files, upgraded 7 unedited starter files, kept 23.
- Fail-closed tiers: a change to `.github/workflows/ci.yml` made `proj check` run the full suite
  ("can affect every test").
- Local duplicate prevention: a second `proj check --full` at `d8155aa182` printed "already passed ...
  not running it again".
- Per-test-file timings recorded from JUnit into `.git/proj/profile.jsonl`; heavy tier (`npm audit`) passed.
- `proj ready` on a PR already verified at `66898bb11b`: "already ready ... CI is verified: not
  triggering another run".
- CI reuse: a manual `workflow_dispatch` for the same SHA (run 40588241044) finished in 6 s; the reuse
  step hit and checkout, install, tests and upload were all `skipped`.
- Ephemeral self-hosted runner: `proj runner use` + `proj runner start --docker`; the next push
  (`bc6ef6c6ab`) ran `verify` on runner `proj-docker-<host>-10272137` (labels self-hosted, proj-ephemeral),
  `success` in 51 s and 0 billed minutes; afterwards the container was gone and 0 runners were registered.
- `proj perf`: 7 billed minutes over 15 runs, per-job median/p95, costliest steps, and two concrete
  opportunities (timeout 15 min vs p95 under 1 min; minutes on cancelled runs). Dependabot's own update
  jobs are counted as free.
- `proj bench --runs 3`: baseline 1.3 s, serial 1.7 s, 2 shards 0.8 s local but 2 billed minutes, 4 shards
  4 billed minutes -> "Keep the current setup" (sharding would cost more minutes for no CI wall-clock gain).
- `proj finish ci-efficiency --merge` merged exactly `bc6ef6c6ab` -> `a90d120`.

## 6. Re-verification after the final adversarial review (PR #4)

The review hardened: opt-ins (compute, runners) read only from `~/.proj/config.json`; CI verdict and reuse keyed
on the CI workflow's own runs (a job named `verify` elsewhere never counts); one concurrency group per PR;
self-hosted routing excludes bot-authored PRs and bot branches; runner token passed on stdin; importer-aware,
fail-closed test selection. Re-run live on the upgraded templates:

- `proj ready --wait` on `7e475ebb75` ran `verify` on container runner `proj-docker-<host>-10272201`
  (`--cap-drop ALL`, `docker inspect` shows no `RUNNER_TOKEN`), `success` in 25 s; 0 runners left afterwards.
- Same-SHA `workflow_dispatch` (run 40591609063) on GitHub-hosted: reuse step hit, tests `skipped`, 8 s.
- `proj ready` again: "already ready ... CI is verified: not triggering another run".
- `proj finish reverify --merge` merged exactly `7e475ebb75` -> `9122675`. Worktree removal was refused while
  a shell sat inside it ("in use by another process ... nothing was removed"); re-running `proj finish`
  completed the cleanup.
- Starter's own CI on `windows-latest` (run 40591692695, commit `b519bab`): 88/88 pass.

## 7. Automated tests

`npm test`: 88 tests, 88 pass, 0 fail (~30-70 s on this PC; also green on `windows-latest`). They cover bootstrap for 3 stacks, adopt and
upgrade, task caps, duplicates and overlap (including 4 concurrent `proj task` runs), checkpoint/restore
(partial commits, deletions), finish/clean safety (dirty, detached HEAD, ignored secrets, unmerged), corrupt
state, hooks, offload exit codes and host pinning, test-tier selection (importers, fixtures, manifests), duplicate
prevention (command-aware), CI verdicts (draft/ready races), JUnit profiling, billed-minute math, benchmarks
(coverage-proven only), runner token handling, config opt-in isolation and static checks on every CI template.
