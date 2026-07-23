# Configuration

Set with `glorious config set <key> <value>`; read with `glorious config get <key>`.

## Where it lives

- Global: `~/.config/glorious/config.json`
- Project: `.glorious/config.json`, then `.glorious/config.local.json` (machine-local, keep it gitignored)

Project layers override global; explicit CLI input wins over all. Secrets like the Azure key live in the OS keychain, never in these files.

## Models

Glorious routes by **tier**, not a raw model id: you define an ordered ladder once, and modes and subagents point at a rung. Swapping the ladder never touches routing config.

| key | default | meaning |
|---|---|---|
| `agent.llm.model` | `gpt-5.6-luna` | primary model id |
| `agent.llm.provider` | `azure` | provider (Azure AI Foundry is wired in) |
| `agent.llm.providers.azure.apiKey` | — | Azure key — keychain only, set with `--secret` |
| `agent.llm.tiers` | `[]` | ordered model ladder |
| `agent.llm.modes.plan` | `0` | ladder tier for plan mode (0 = frontier) |
| `agent.llm.modes.build` | `1` | ladder tier for build mode |
| `agent.tools.subagents.tier` | — | tier for subagents and planning workers |
| `agent.tools.subagents.concurrency` | `2` | max concurrent subagents per fan-out |

## Permissions

The full model is in [permissions](/permissions).

| key | default | meaning |
|---|---|---|
| `permissions.edit` | `allow` | file edits: allow / ask / deny |
| `permissions.bash.default` | `ask` | unlisted bash commands |
| `permissions.bash.allow` / `.deny` | `[]` | command prefixes (trailing `*` ok) |
| `permissions.mcp.default` | `ask` | MCP tool calls |
| `permissions.web` | `allow` | outbound search and fetch |

## Tools & context

| key | default | meaning |
|---|---|---|
| `agent.tools.edit.mode` | `batch` | edit strategy: exact / batch / hash |
| `agent.tools.maxOutputChars` | `30000` | cap on tool output to the model (overflow spills to a file) |
| `agent.context.softLimit` | — | input-token threshold; interactive history compacts at 75% |
| `agent.context.onLimit` | `warn` | behavior when a request crosses the soft limit |
| `agent.steps` | `100` | per-turn tool-loop ceiling — runaway guard, not a work budget |
| `update.auto` | `true` | check for updates on startup (never auto-installs) |
| `update.channel` | `auto` | persistent release channel: `next` or `latest` |
