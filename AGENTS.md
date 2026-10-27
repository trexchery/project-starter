# AGENTS.md

`proj` CLI (bin/, lib/) and the project template it renders (template/). Zero runtime dependencies.

- Test: `npm test` (node:test, temp repos, PROJ_OFFLINE=1, no network). Keep it under a minute.
- Never break the safety contract: no `--force` anywhere, no deletion without an archive ref and a merge
  proof, no outward action (GitHub writes, CI dispatch, merges) without `--yes`, skipped CI is never verified.
- Template changes reach existing projects through `proj adopt --upgrade` only for files users never edited,
  so keep template files small and stable. Never put project-specific decisions or secrets in template/.
- Windows first: spawn without a shell except for user-configured check commands; paths via `path`.
