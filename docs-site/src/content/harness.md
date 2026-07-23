# Agent Harness

`@glrs-dev/harness-plugin-opencode` — an OpenCode plugin that registers [agents](/harness/agents), [tools](/harness/tools), [commands](/harness/commands), MCP servers, and skills.

## Install

```bash
curl -fsSL https://glrs.dev/install.sh | bash
```

Or manually: `npm i -g @glrs-dev/cli && glrs harness install && opencode`

## What's in the box

- **27 [agents](/harness/agents)** — from the primary `prime` agent to specialized subagents for code review, research, planning, and architecture
- **7 [slash commands](/harness/commands)** — `/fresh`, `/ship`, `/review`, `/research`, `/init-deep`, `/costs`, `/dispatches`
- **5 [tools](/harness/tools)** — `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`
- **5 MCP servers** — serena, memory, git (enabled), playwright, linear (disabled)
- **18 [skills](/harness/skills)** — code quality, design, research, review, React best practices, and more
- **7 sub-plugins** — cost tracking, dispatch logging, stall detection, tool hooks, notifications

## How it works

The plugin's `config` hook runs at OpenCode startup. It registers everything from `node_modules` — no files are written to `~/.config/opencode/agents/` or similar. Your `opencode.json` values always win over plugin defaults.

## Workflow

The default workflow is [SPEAR](https://www.edge.ceo/p/introducing-spear-the-management): **scope → plan → execute → assess → resolve.** The [`prime`](/harness/agents) agent drives it end-to-end.

```
/fresh add rate limiting to the upload endpoint
```

1. `prime` scopes the work — reads the codebase, identifies affected files
2. Delegates to [`@plan`](/harness/agents) for a structured implementation plan
3. [`@plan-reviewer`](/harness/agents) adversarially reviews the plan
4. `prime` dispatches [`@build`](/harness/agents) to implement
5. [`@code-reviewer`](/harness/agents) checks the output
6. [`/ship`](/harness/commands) squashes, pushes, and opens a PR

For tasks that need heavyweight orchestration, use [`prime-heavy`](/harness/agents) (Opus).

## Pages

- [Agents](/harness/agents) — full reference of all 27 agents
- [Commands](/harness/commands) — the 7 slash commands
- [Tools](/harness/tools) — the 5 custom tools
- [Configuration](/harness/config) — model overrides, MCP servers, environment variables
