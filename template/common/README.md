# {{name}}

{{description}}

## Develop

```powershell
proj task <slug> --goal "what changes"   # isolated worktree for one deliverable
proj check                               # affected tests; --full before ready
proj checkpoint --push                   # back up work, open/update the draft PR (no CI minutes)
proj ready                               # PR ready: CI verifies the exact SHA, once
proj finish <slug> --merge               # squash-merge that verified SHA, clean up
```

Brief: [docs/BRIEF.md](docs/BRIEF.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Agents: [AGENTS.md](AGENTS.md)
