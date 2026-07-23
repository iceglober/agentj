## Configuration reference

Set with `glorious config set <key> <value>`; read with `glorious config get <key>`. Global writes use `~/.config/glorious/config.json`; project settings layer from `.glorious/config.json` and `.glorious/config.local.json`. Defaults come straight from the schema.

:::details Show all configuration keys

- `agent.llm.model` (default: `"gpt-5.6-luna"`) — The primary model id the agent runs on.
- `agent.llm.provider` (default: `"azure"`) — Model provider. Azure AI Foundry is wired in.
- `agent.llm.providers.azure.apiKey` (default: unset) — Azure AI Foundry API key, stored only in your OS keychain.
- `agent.llm.tiers` (default: `[]`) — Ordered model ladder. Modes and subagents route to a tier index instead of a raw model id, so swapping the ladder never touches routing config.
- `agent.llm.modes.plan` (default: `0`) — Ladder tier plan mode runs on. Defaults to the frontier tier (0).
- `agent.llm.modes.build` (default: `1`) — Ladder tier build mode runs on.
- `agent.tools.subagents.tier` (default: unset) — Ladder tier subagents and planning workers run on — route fan-out to a cheaper rung.
- `agent.tools.subagents.model` (default: unset) — Explicit model for subagents (deprecated — prefer `tier`; wins over it when set).
- `agent.tools.subagents.concurrency` (default: `2`) — Maximum subagents run at once within a single fan-out.
- `agent.tools.edit.mode` (default: `"batch"`) — Edit-tool strategy: `exact`, `batch`, or `hash`.
- `agent.tools.maxOutputChars` (default: `30000`) — Character cap on tool output returned to the model. Over-cap output spills to a session file so nothing is lost.
- `agent.context.softLimit` (default: unset) — Request input-token threshold: interactive history compacts at 75%, then `onLimit` applies at the threshold. Unset means no ceiling.
- `agent.context.onLimit` (default: `"warn"`) — Behavior when a request crosses the soft limit: `warn` posts a notice to wrap up or delegate.
- `agent.steps` (default: `100`) — Per-turn tool-loop ceiling (model round-trips) — runaway protection, not a work budget.
- `tui.renderer` (default: `"opentui"`) — Terminal UI: `opentui` (full-screen, default) or `ansi` (live-region). `GLORIOUS_TUI` overrides for one session.
- `permissions.uncaged` (default: `false`) — Open season: allow every gated tool call, bypassing the rules. Off by default.
- `permissions.rules` (default: `{}`) — Default-deny access control. A map of tool-call patterns to `allow`/`ask`/`deny`; anything unmatched is denied. Patterns: `bash(pnpm *)`, `edit`, `web`, `mcp_linear_get_issue` (or `mcp_linear_*`). deny beats allow beats ask. Set with `glorious config allow|ask|deny <pattern>`.

:::
