# {{name}}

{{description}}

## Develop

```powershell
proj task <slug> --goal "what changes"   # isolated worktree for one deliverable
proj check                               # affected tests; --full before ready
proj checkpoint --push                   # back up work, open/update the draft PR (no CI minutes)
proj ready --yes                         # owner-approved: PR ready, CI verifies the exact SHA
proj finish <slug> --merge --yes         # owner-approved: squash-merge that SHA, clean up
```

Brief: [docs/BRIEF.md](docs/BRIEF.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Agents: [AGENTS.md](AGENTS.md)
