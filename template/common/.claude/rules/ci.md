---
paths:
  - ".github/workflows/**"
---
CI cost rules: every job keeps `if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false`
so drafts spend no minutes; `pull_request` types keep `ready_for_review`; checkout uses the exact head SHA;
the required job stays named `verify`; skip at job level, never with `on.paths` (a required check would
then wait forever). Heavy suites stay `workflow_dispatch` only.
