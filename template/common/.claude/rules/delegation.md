Subagent routing for Claude Code. The owner's choice of model, effort and Ultracode for the main session stands;
each subagent below carries its own model and effort.

| Work | Agent | Model, effort |
| --- | --- | --- |
| Lookups, file search, log and diff summaries (read-only) | `scout` | haiku, low |
| Scoped implementation with tests | `implementer` | sonnet, medium |
| Diff review before a pull request is ready | `reviewer` | sonnet, high |
| Architecture; debugging that failed once | `deep` | opus, high |
{{#security}}
| Changes touching {{sensitiveList}} | `security` | opus, high |
{{/security}}
{{#visual}}
| Design references and patterns | `design-researcher` | sonnet, medium |
| Independent critique of screenshots | `visual-critic` | opus, high |
{{/visual}}

In large fan-outs (workflows), size the number of agents to the independent work items. Use the cheap tier for
discovery and the strong tier only for judging risky findings and synthesis.

## Token budget

Every agent re-reads its whole context on every turn, so output that enters context is paid for again on every later
turn. In practice these re-reads are almost all of a workflow's tokens.

- Cap command output: `| head -50`, `| tail -30`, `grep -c`, `wc -l`, `git diff --stat`. For long logs or test runs,
  write to a scratch file and grep it.
- Read files with offset/limit when only part matters; grep first to find the lines.
- Workflow briefs: give file paths, not pasted notes. One narrow question per agent. Prefer 3-5 agents over 10+.
- Tell each agent to finish within about 40 turns and return at most 300 words; detail goes in a file.
