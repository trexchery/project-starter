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
