---
name: proj-audit
description: Git and GitHub repo hygiene check with the `proj` CLI - stale or merged branches, orphaned or forgotten git worktrees, idle or failing pull requests, duplicate issues, outdated dependencies, GitHub Actions minutes used and CI cost hotspots - then safe branch and worktree cleanup. Use for a repo health check, cleaning up old branches or worktrees, checking PR/CI state, or finding what wastes Actions minutes. Not for reviewing code quality.
argument-hint: "[clean | ci]"
allowed-tools: Bash(proj version), Bash(proj doctor *), Bash(proj perf *), Bash(proj clean), Bash(git rev-parse *), Bash(gh auth status*)
---

# proj audit

Arguments: `$ARGUMENTS` (empty = full audit; `clean` = also apply safe cleanup; `ci` = CI cost only).

## 1. Preconditions (stop at the first that fails, say why in one line)

1. `git rev-parse --show-toplevel` must succeed. Otherwise: "Not inside a git repository." Stop.
2. `proj version` must succeed. Otherwise tell the user it needs the `proj` CLI (Node 22+):
   `npm install -g github:trexchery/project-starter` — then stop. Do not install it yourself.
3. `gh auth status` decides the mode: if it fails, or the repo has no GitHub `origin`, add `--offline`
   to every `proj` command below and say once that GitHub checks (PRs, CI, issues, minutes) were skipped.

## 2. Collect (skip what the argument excludes)

- Health: `proj doctor --json --deps [--offline]`. Parse the JSON: `repos[].findings[]` with `sev`
  (`warn` > `info` > `ok`), `what`, `fix`; `starter` is non-null when proj itself has an update.
- CI cost (online only): `proj perf --runs 20 --json`. Use `ci.totalBilled`, `ci.duplicates`, `ci.cancelled`,
  `ci.jobStats`, and the first entries of `opportunities` (already ranked by minutes).
- Cleanup preview: `proj clean` (a dry run; lists only provably merged branches and finished worktrees).

If a command exits non-zero, report its last line verbatim and continue with the others.

## 3. Act only when asked

Only when the argument is `clean`, or the user explicitly asked to clean up: run `proj clean --apply`.
It archives every branch under `refs/proj-archive/` before deleting and never touches dirty, unmerged,
locked or recently active work. Never delete or reset anything any other way (no `git branch -D`,
no `--force`, no `git worktree remove`, no `git clean`).

## 4. Report (exactly this shape, nothing more)

- Line 1: the single most useful next action, as a runnable command.
- Up to 5 findings, `warn` before `info`, each as `what -> fix`. Omit `ok` items.
- One line: `Actions minutes this month: N/limit` (when known) plus the top CI saving from `proj perf`, if any.
- One line: what `proj clean` would remove, or "nothing to clean". After `--apply`, what was removed.
- If nothing needs attention: one line saying the repo is healthy.
