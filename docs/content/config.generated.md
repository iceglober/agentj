## Configuration reference

Set with `agentj config set <key> <value>`; read with `agentj config get <key>`. Global writes use `~/.config/aj/config.json`; project settings layer from `.aj/config.json` and `.aj/config.local.json`. Defaults come straight from the schema.

:::details Show all configuration keys

- `agent.llm.model` (default: `"gpt-5.6-luna"`) — The primary model id the agent runs on.
- `agent.llm.provider` (default: `"azure"`) — Model provider. Azure AI Foundry is wired in.
- `agent.llm.providers.azure.apiKey` (default: unset) — Azure AI Foundry API key, stored only in your OS keychain.
- `agent.llm.tiers` (default: `[]`) — Ordered model ladder. Modes and subagents route to a tier index instead of a raw model id, so swapping the ladder never touches routing config.
- `agent.llm.modes.plan` (default: `0`) — Ladder tier plan mode runs on. Defaults to the frontier tier (0).
- `agent.llm.modes.build` (default: `1`) — Ladder tier build mode runs on.
- `agent.reflections.events` (default: `["plan.once.post_turn"]`) — Reflection hooks: plan.once or plan.each, before or after a plan turn. Defaults to one post-turn review; an empty array disables scheduling.
- `agent.reflections.prompts` (default: `{}`) — Named parallel review instructions. Empty by default; add prompts to enable reflections. After a plan draft, the model chooses which named reviews run; the choice and each review's bounded findings are shown before revision.
- `agent.reflections.tier` (default: unset) — Ladder tier reflection workers run on. Reflection model and provider overrides win; otherwise subagent routing applies.
- `agent.reflections.model` (default: unset) — Explicit model for reflection workers; wins over reflections.tier.
- `agent.reflections.provider` (default: unset) — Provider override for reflection workers; otherwise subagent routing applies.
- `agent.tools.subagents.tier` (default: unset) — Ladder tier subagents and planning workers run on — route fan-out to a cheaper rung.
- `agent.tools.subagents.model` (default: unset) — Explicit model for subagents (deprecated — prefer `tier`; wins over it when set).
- `agent.tools.subagents.concurrency` (default: `2`) — Maximum subagents run at once within a single fan-out.
- `agent.tools.edit.mode` (default: `"batch"`) — Edit-tool strategy: `exact`, `batch`, or `hash`.
- `agent.tools.maxOutputChars` (default: `30000`) — Character cap on tool output returned to the model. Over-cap output spills to a session file so nothing is lost.
- `agent.context.softLimit` (default: unset) — Request input-token threshold: interactive history compacts at 75%, then `onLimit` applies at the threshold. Unset means no ceiling.
- `agent.context.onLimit` (default: `"warn"`) — Behavior when a request crosses the soft limit: `warn` posts a notice to wrap up or delegate.
- `agent.steps` (default: `100`) — Per-turn tool-loop ceiling (model round-trips) — runaway protection, not a work budget.
- `permissions.edit` (default: `"allow"`) — Policy for file edits in build mode: `allow`, `ask`, or `deny`.
- `permissions.bash.default` (default: `"ask"`) — Default policy for bash commands, before the allow/deny lists.
- `permissions.bash.allow` (default: `[]`) — Command prefixes (optional trailing `*`) that skip the prompt.
- `permissions.bash.deny` (default: `[]`) — Command prefixes that are always refused; checked before allow.
- `permissions.mcp.default` (default: `"ask"`) — Default policy for MCP tool calls, before the allow/deny lists.
- `permissions.web` (default: `"allow"`) — Policy for outbound web searches and URL fetches: `allow`, `ask`, or `deny`.

:::
