---
name: new-project
description: Start a new project from a plain-language idea. Understands what is being built, then creates a tailored, agent-ready repository with the proj CLI - stack, tests, cheap CI, GitHub protections, AGENTS.md and CLAUDE.md, specialist subagents with their own models, security and database rules where they apply, and a Creative Director kit only for visual products. Use when someone wants to start, create, bootstrap, scaffold or set up a new project, app or repository.
argument-hint: "[name] [what you are building]"
allowed-tools: Bash(proj version), PowerShell(proj version), Bash(proj new *), PowerShell(proj new *), Bash(proj protect), PowerShell(proj protect), Bash(gh auth status*), PowerShell(gh auth status*), Bash(cd *), PowerShell(cd *), Bash(npm test), PowerShell(npm test), Bash(python -m pytest*), PowerShell(python -m pytest*), Bash(pwsh -NoProfile -File scripts/check.ps1), PowerShell(pwsh -NoProfile -File scripts/check.ps1), Bash(git add -A), PowerShell(git add -A), Bash(git commit *), PowerShell(git commit *), Bash(git push origin main), PowerShell(git push origin main), Bash(git rev-parse HEAD), PowerShell(git rev-parse HEAD), Bash(git ls-remote origin *), PowerShell(git ls-remote origin *)
---

# New project

Input: `$ARGUMENTS` plus anything said earlier in the conversation.

## 1. Understand what is being built

Work out, from what the person said:
- `name`: short, lowercase, hyphenated;
- `description`: one or two sentences: who it is for, what it does;
- `kind`: web-app, website, mobile-app, game, api, cli, library, data or other;
- `stack`: node, python or generic (generic covers Go, Rust, Swift and others);
- `visual`: true only if people will look at screens or pages it renders;
- `sensitive`: any of auth (accounts, login), payments, pii (personal data), secrets (keys it stores); or none;
- `database`: true if it stores data in a database.

Ask at most three short questions in one message, and only about things that change the setup and cannot be
inferred (usually: stack preference, whether it has a UI, whether it handles accounts, money or personal data).
Never ask about names, folders or details with sensible defaults.

## 2. Create it

1. `proj version`. If it fails, the `proj` CLI is missing: tell the person to install it with
   `npm install -g github:trexchery/project-starter`, and stop.
2. `gh auth status`. If it fails, or the person wants it local only, use `--no-remote`. Otherwise use
   `--no-protect`: `proj new` creates the private GitHub repository and pushes it, and protection waits until
   your tailoring commit is pushed (step 5), because a protected `main` refuses direct pushes.
3. Run, with every profile field given as a flag (no temporary file needed):
   `proj new <name> "<description>" --kind <kind> --stack <stack> --visual|--no-visual --sensitive <list>|none --database|--no-database --no-protect`
   (`--no-remote` instead of `--no-protect` when local only; add `--dir <parent>` when the person named a folder).
   Show its "Understood:" line.
4. Move into the new repository with `cd <name>` (or `cd <parent>/<name>`) as a command on its own. Run every later
   command from there, one per call, exactly as written below: no `&&` chains, no `git -C`, no `--prefix`. Those
   forms do not match the commands this skill is allowed to run, and the session would stop for approval.

## 3. Tailor what a template cannot know

In the new repository:
- `docs/BRIEF.md`: fill users, first deliverable, out of scope, done when and constraints from the conversation;
  write "TBD" where nothing was said. Never invent requirements.
- `AGENTS.md`, section "Project": add up to five project-specific facts or rules learned in the conversation
  (domain terms, invariants, integrations). Nothing generic: the template already covers that.
- Generic stack only (Go, Rust, Swift, C#, ...): `scripts/check.ps1` fails with "NOT VERIFIED" until it lists a real
  test command. Set up the toolchain's minimal skeleton with one passing test and add its command to `$tests` in
  `scripts/check.ps1` (`go test ./...`, `cargo test`, `dotnet test`). Add the language's build outputs to
  `.gitignore`, its package ecosystem to `.github/dependabot.yml`, and its setup step to `.github/workflows/ci.yml`.
  CI runs the check with `pwsh`, which GitHub's runners include; locally it needs PowerShell 7. If the toolchain is
  not installed here, leave the placeholder failing and say so.

Never set a model or effort in the project's settings (the owner chooses those), never add design files to a
project without screens, and never copy anything from other repositories.

## 4. Verify

Run the test command named in `AGENTS.md` (`npm test`, `python -m pytest` or
`pwsh -NoProfile -File scripts/check.ps1`) and note its exit code. Only exit 0 from real tests counts as verified.
A failing or placeholder check ("NOT VERIFIED", exit 2) is reported as not verified, never as passing.

## 5. Commit, push, protect

1. `git add -A`, then `git commit -m "docs: tailor brief and agent instructions"`.
2. Local only (`--no-remote`): stop here.
3. `git push origin main`.
4. `git rev-parse HEAD` and `git ls-remote origin refs/heads/main`: the two SHAs must be identical. If they differ
   or the push failed, push once more. If they still differ, report the mismatch and never call the repository set up.
5. `proj protect`, even if the push failed, so the repository is never left unprotected. Show its
   "branch protection:" line.

## 6. Hand over

Reply with: the path and GitHub URL; the pushed SHA and whether the remote matches it; what the project received
(the "Understood:" line); the test result from step 4 (verified, or not verified and why); and the next step: for a
visual project, `/creative-director` to choose the look before building screens; otherwise, describe the first
feature.
