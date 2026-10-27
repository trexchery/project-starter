Subagent routing for Claude Code (tiers from AGENTS.md "Delegation and model routing"):

| Work | Agent | Model, effort |
| --- | --- | --- |
| Lookups, file search, log/diff summaries (read-only) | `scout` | haiku, low |
| Scoped implementation with tests | `implementer` | sonnet, medium |
| Diff review before ready | `reviewer` | sonnet, high |
| Architecture; debugging that failed once | `deep` | opus, high |
| Auth, secrets, money, permissions, untrusted input | `security` | opus, high |

For large fan-outs (ultracode workflows), size the fleet to the independent work items, use the cheap tier
for discovery and the strong tier only for judging, verification of risky findings, and synthesis.
