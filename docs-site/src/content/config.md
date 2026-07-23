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

A default-deny access-control list — see [permissions](/permissions).

| key | default | meaning |
|---|---|---|
| `permissions.uncaged` | `false` | allow every gated tool call (open season) |
| `permissions.rules` | `{}` | map of tool-call patterns → `allow`/`ask`/`deny`; unmatched → deny |

Edit rules with the idempotent verbs rather than by hand:

```sh
glorious config allow "bash(pnpm *)"
glorious config deny  "bash(rm -rf *)"
glorious config uncaged on
```

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
