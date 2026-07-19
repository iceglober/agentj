---
"@glrs-dev/aj": minor
---

`agentj config` with no subcommand now opens an interactive editor. It lists the configurable keys with their current values and lets you edit each with the right control for its type — a menu for enums, true/false for booleans, masked entry for the provider key, a numeric field, or an add/remove list for arrays like `agent.llm.tiers` — persisting through the same path as `config set`. The subcommands (`config get`/`set`/`delete`) are unchanged; non-interactive use still errors cleanly.
