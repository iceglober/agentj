---
"@glrs-dev/aj": minor
---

Cost-optimization change set: provider-agnostic model tier ladder (`llm.tiers`/`llm.modes`, plan rides the frontier tier, subagents route via `tools.subagents.tier`; an explicit runtime model selection overrides mode routing); configurable tool-output caps with spill-to-file recovery and readFile `offset`/`limit`; config-driven OTLP metrics export (`metrics.*`); live cache-read ratio next to ctx in the status line; and a context soft limit (`agent.context.softLimit`) that warns the interactive session and stops fresh-context children at the same ceiling.
