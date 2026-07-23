# Configuration

```sh
glorious config set <key> <value>
glorious config get <key>
```

## Location

- Global: `~/.config/glorious/config.json`
- Project: `.glorious/config.json`, then `.glorious/config.local.json` (machine-local)

Project layers override global; explicit CLI input wins over all. Secrets live in the OS keychain, not these files.

## Models

Modes and subagents route to a ladder tier, not a raw model id.

| key | default | meaning |
|---|---|---|
| `agent.llm.model` | `gpt-5.6-luna` | primary model id |
| `agent.llm.provider` | `azure` | provider (Azure AI Foundry) |
| `agent.llm.providers.azure.apiKey` | — | Azure key; keychain only, set with `--secret` |
| `agent.llm.tiers` | `[]` | ordered model ladder |
| `agent.llm.modes.plan` | `0` | ladder tier for plan mode (0 = frontier) |
| `agent.llm.modes.build` | `1` | ladder tier for build mode |
| `agent.tools.subagents.tier` | — | tier for subagents and planning workers |
| `agent.tools.subagents.concurrency` | `2` | max concurrent subagents per fan-out |

## Permissions

See [permissions](/permissions).

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
| `agent.tools.maxOutputChars` | `30000` | cap on tool output; overflow spills to a file |
| `agent.context.softLimit` | — | input-token threshold; history compacts at 75% |
| `agent.context.onLimit` | `warn` | behavior when a request crosses the soft limit |
| `agent.steps` | `100` | per-turn tool-loop ceiling |
| `update.auto` | `true` | check for updates on startup |
| `update.channel` | `auto` | release channel: `next` or `latest` |
