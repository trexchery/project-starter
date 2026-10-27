# project-starter

Describe what you are building; get a repository set up the way a careful senior engineer would set it up for
you: tailored to the project, ready for AI coding agents, cheap to run in CI, and protected on GitHub.

```powershell
proj new mealplan "A web app where families plan weekly meals and pay a monthly subscription with Stripe"
```

```text
Understood: web-app on node · visual (Creative Director kit) · security reviewer for auth, payments
```

## Install

In Claude Code (adds the `new-project` skill and puts `proj` on Claude's shell PATH):

```text
/plugin install project-starter --marketplace trexchery/project-starter
```

Then say "start a new project: …" or run `/project-starter:new-project`. Claude asks at most three questions,
creates the repository, and fills in the brief and project-specific rules from your conversation.

For your own terminal (Windows, macOS, Linux; Node 22+, git, and `gh` for GitHub):

```powershell
npm install -g github:trexchery/project-starter
proj new <name> "what you are building"
```

On Windows, if `proj` is not found afterwards, install into the per-user npm folder:
`npm install -g --prefix "$env:APPDATA\npm" github:trexchery/project-starter`.

## What a project gets

Every project:

- the stack's skeleton with a passing test for node and python; for other languages a placeholder check that the
  `new-project` skill replaces with the real toolchain;
- `AGENTS.md` as the single source of truth for every agent, and `CLAUDE.md` importing it;
- subagents that pick their own model and effort: `scout` (haiku, low), `implementer` (sonnet, medium),
  `reviewer` (sonnet, high), `deep` (opus, high), with matching Codex agents;
- CI that costs nothing on draft pull requests and runs once per commit when one is marked ready;
- Dependabot, issue and PR templates, `docs/BRIEF.md`, `docs/DECISIONS.md`, LF line endings, safe git defaults;
- a private GitHub repository with squash-only merges and a ruleset that requires the CI check (skip with
  `--no-remote`).

Only when it fits:

| The description mentions | The project also gets |
| --- | --- |
| screens: a web app, website, mobile app or game | the Creative Director kit: `/creative-director` skill, `design-researcher` and `visual-critic` agents, `DESIGN.md`, UI rules |
| accounts, payments, personal data or stored keys | a `security` reviewer agent, rules scoped to auth and payment code, and a "Sensitive areas" section |
| a database | migration and test-isolation rules scoped to schema code |
| `--tasks` | session hooks and the optional task workflow ([utilities](docs/UTILITIES.md)) |

A command-line tool or library gets no design files; a project without sensitive data gets no security
reviewer. `proj new` prints what it understood and why; flags override it (`--visual`, `--no-visual`,
`--sensitive auth,payments`, `--database`, `--stack python`), and `--profile file.json` sets everything exactly.

## Your model stays yours

Nothing in a generated project sets the main session's model, reasoning effort, or Ultracode and workflow use:
those stay your choice. Each subagent declares its own model and effort, and `AGENTS.md` tells agents to route
cheap work to cheap tiers and escalate only after a failed attempt.

## Creative Director (visual projects only)

`/creative-director` researches references, renders three deliberately different directions as real pages with
desktop and mobile screenshots (`proj shot`), has `visual-critic` review them without seeing the designer's
reasoning, and stops for your choice. Only then does it write `DESIGN.md` (tokens, components, accessibility),
which every later UI change is checked against.

See [docs/EXAMPLES.md](docs/EXAMPLES.md) for four generated projects and a real Creative Director run with its
screenshots.

## Existing repositories

```powershell
proj adopt --dry-run     # what it would add, based on what the repo looks like
proj adopt               # adds missing pieces, never overwrites a file
proj adopt --upgrade     # later: refresh starter files you never edited
proj protect             # squash-only merges, Dependabot, ruleset
```

## Optional utilities

Task worktrees with crash recovery, exact-commit verification, CI cost profiling and benchmarks, self-hosted
runners, remote compute, and repo health audits are available but never required: see
[docs/UTILITIES.md](docs/UTILITIES.md). `proj help` lists every command.

## Develop

`npm test` runs the suite (temp repos, local bare remotes, no network) in under a minute on Windows and Linux.
`node scripts/gen-workflows.mjs` regenerates the stacks' CI workflows from one source.

## License

MIT
