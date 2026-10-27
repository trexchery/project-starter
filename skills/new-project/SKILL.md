---
name: new-project
description: Start a new project from a plain-language idea. Understands what is being built, then creates a tailored, agent-ready repository with the proj CLI - stack, tests, cheap CI, GitHub protections, AGENTS.md and CLAUDE.md, specialist subagents with their own models, security and database rules where they apply, and a Creative Director kit only for visual products. Use when someone wants to start, create, bootstrap, scaffold or set up a new project, app or repository.
argument-hint: "[name] [what you are building]"
allowed-tools: Bash(proj version), Bash(proj new *), Bash(gh auth status*)
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
2. `gh auth status`. If it fails, or the person wants it local only, add `--no-remote`. Otherwise `proj new`
   creates a private GitHub repository and applies branch protection.
3. Write the profile to a temporary JSON file:
   `{"description": "...", "kind": "...", "stack": "...", "visual": true, "sensitive": ["auth"], "database": false}`
4. Run `proj new <name> --profile <file> [--no-remote] [--dir <parent>]` (parent: the folder the person named,
   else the current folder). Show its "Understood:" line.

## 3. Tailor what a template cannot know

In the new repository:
- `docs/BRIEF.md`: fill users, first deliverable, out of scope, done when and constraints from the conversation;
  write "TBD" where nothing was said. Never invent requirements.
- `AGENTS.md`, section "Project": add up to five project-specific facts or rules learned in the conversation
  (domain terms, invariants, integrations). Nothing generic: the template already covers that.
- Commit: `docs: tailor brief and agent instructions`.

Never set a model or effort in the project's settings (the owner chooses those), never add design files to a
project without screens, and never copy anything from other repositories.

## 4. Verify and hand over

Run the test command named in `AGENTS.md` and report its exit code. Then reply with: the path (and GitHub URL
if created), what the project received (one line from the "Understood:" output), and the next step: for a visual
project, `/creative-director` to choose the look before building screens; otherwise, describe the first feature.
