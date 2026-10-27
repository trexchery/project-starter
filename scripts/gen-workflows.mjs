import fs from 'node:fs';
import path from 'node:path';
// Generates template/stacks/*/.github/workflows/{ci,heavy}.yml from one source. Run: node scripts/gen-workflows.mjs
const base = path.join(import.meta.dirname, '..', 'template', 'stacks');
// Self-hosted only for code the repo's writers pushed: same-repo PRs not opened by a bot, dispatches of non-bot branches.
const RUNS_ON = "${{ vars.PROJ_RUNS_ON != '' && ((github.event_name == 'workflow_dispatch' && !startsWith(github.ref_name, 'dependabot/')) || (github.event.pull_request.head.repo.full_name == github.repository && !endsWith(github.event.pull_request.user.login, '[bot]'))) && fromJSON(vars.PROJ_RUNS_ON) || 'ubuntu-latest' }}";
const NOHIT = "steps.reuse.outputs.hit != 'true'";
// One full run per SHA: reuse a successful run of THIS workflow file for the exact commit it tested.
// CI runs test their head SHA; Heavy runs test inputs.sha, which their run-name records.
const reuse = (file, shaExpr, byTitle) => `      # One full run per SHA: if this workflow already passed for this exact commit, report that instead of re-testing.
      - name: Reuse a passing result for this exact SHA
        id: reuse
        if: \${{ !inputs.force }}
        uses: actions/github-script@v9
        env:
          SHA: ${shaExpr}
        with:
          script: |
            const { data } = await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id: '${file}', status: 'success', ${byTitle ? '' : 'head_sha: process.env.SHA, '}per_page: 100 });
            const prior = data.workflow_runs.find((r) => r.id !== context.runId && ${byTitle ? 'r.display_title === `Heavy ${process.env.SHA}`' : 'r.head_sha === process.env.SHA'});
            if (prior) { core.setOutput('hit', 'true'); await core.summary.addRaw(\`Reused the passing run for \${process.env.SHA}: \${prior.html_url}\`).write(); }
`;
const checkout = (ref) => `      - uses: actions/checkout@v7
        if: ${NOHIT}
        with:
          ref: ${ref}
          persist-credentials: false
      - name: Record the exact SHA under test
        if: ${NOHIT}
        run: echo "Verified SHA $(git rev-parse HEAD)" | tee -a "$GITHUB_STEP_SUMMARY"
`;
const step = (s) => s.split('\n').filter(Boolean).map((l) => l.startsWith('- ') ? `      ${l}\n        if: ${NOHIT}` : `        ${l}`).join('\n') + '\n';
const timings = `      # Per-test-file durations, for finding slow tests (tiny artifact, kept 7 days).
      - uses: actions/upload-artifact@v7
        if: always() && ${NOHIT}
        with:
          name: test-timings-\${{ github.run_id }}
          path: junit.xml
          if-no-files-found: ignore
          retention-days: 7
`;
const S = {
  node: {
    setup: `- uses: actions/setup-node@v7\nwith: { node-version: 24 }\n- run: npm ci`,
    test: `- run: npm test -- --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=junit.xml`,
    heavy: `- run: npm audit --audit-level=high\n- run: npm run test:heavy --if-present`, junit: true,
  },
  python: {
    setup: `- uses: actions/setup-python@v7\nwith: { python-version: "3.12" }\n- run: python -m pip install -e ".[test]"`,
    test: `- run: python -m pytest -q --junitxml=junit.xml`,
    heavy: `- run: python -m pip install pip-audit && pip-audit\n- run: if [ -d tests/heavy ]; then python -m pytest -q tests/heavy; fi`, junit: true,
  },
  generic: {
    setup: '', test: `- run: pwsh -NoProfile -File scripts/check.ps1`,
    heavy: `- run: if [ -f scripts/heavy.ps1 ]; then pwsh -NoProfile -File scripts/heavy.ps1; else echo "no heavy suite"; fi`, junit: false,
  },
};
for (const [stack, x] of Object.entries(S)) {
  const ci = `name: CI
# Cost rules (details: AGENTS.md):
# - Drafts spend nothing: the job is skipped before a runner starts; ready_for_review runs it on the head SHA.
#   A skipped check is NOT a pass: only conclusion=success for the exact head SHA verifies a commit.
# - One full run per SHA: a later trigger (dispatch, reopen, re-ready) for a SHA this workflow already
#   passed reuses that run. New commits on a PR cancel its superseded run (one concurrency group per PR).
# - Self-hosted (optional): repo variable PROJ_RUNS_ON (a runner label) routes only same-repo PRs not
#   opened by bots, and dispatches of non-bot branches, to ephemeral runners; the rest stays GitHub-hosted.
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      force:
        description: Run the full suite even if this SHA already passed
        type: boolean
        default: false

permissions:
  contents: read
  actions: read

jobs:
  verify:
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false
    concurrency:
      group: ci-\${{ github.event.pull_request.number || github.ref }}
      cancel-in-progress: \${{ github.event_name == 'pull_request' }}
    runs-on: ${RUNS_ON}
    timeout-minutes: 15
    defaults:
      run:
        shell: bash
    steps:
${reuse('ci.yml', '${{ github.event.pull_request.head.sha || github.sha }}', false)}${checkout('${{ github.event.pull_request.head.sha || github.sha }}')}${x.setup ? step(x.setup) : ''}${step(x.test)}${x.junit ? timings : ''}`;
  const heavy = `name: Heavy
run-name: Heavy \${{ inputs.sha }}
# Expensive suites (audits, E2E, mutation). Manual only, once per SHA: dispatch it for a
# pushed SHA (\`gh workflow run heavy.yml -f sha=<sha>\`); prefer running them locally or on available external compute first.
on:
  workflow_dispatch:
    inputs:
      sha:
        description: Exact commit to verify
        required: true
      force:
        description: Run even if this SHA already passed
        type: boolean
        default: false

permissions:
  contents: read
  actions: read

jobs:
  heavy:
    concurrency:
      group: heavy-\${{ inputs.sha }}
      cancel-in-progress: false
    runs-on: ${RUNS_ON}
    timeout-minutes: 30
    defaults:
      run:
        shell: bash
    steps:
${reuse('heavy.yml', '${{ inputs.sha }}', true)}${checkout('${{ inputs.sha }}')}${x.setup ? step(x.setup) : ''}${step(x.heavy)}`;
  fs.writeFileSync(`${base}/${stack}/.github/workflows/ci.yml`, ci);
  fs.writeFileSync(`${base}/${stack}/.github/workflows/heavy.yml`, heavy);
}
