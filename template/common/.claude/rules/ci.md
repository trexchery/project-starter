---
paths:
  - ".github/workflows/**"
---
CI cost rules. Every job triggered by `pull_request` keeps
`if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false` (drafts spend no
minutes) and the `ready_for_review` type; skip at job level, never with `on.paths` (a required check would
wait forever). Checkout uses the exact head SHA. Keep the "Reuse a passing result for this exact SHA" step,
the job-level `concurrency` block, the self-hosted `runs-on` guard (same-repo, non-Dependabot PRs or owner
dispatch only) and the required job name `verify`. `workflow_dispatch`-only workflows (Heavy) need no draft
guard. Timeouts follow `proj perf` (about twice the observed p95). Add caching or sharding only with
`proj bench` evidence.
