# Commands & keys

Generated from the command registry that powers `/help`. Do not edit by hand — run `bun run docs`.

## Slash commands

- `/help` — List commands and keys
- `/mcp` — Manage and reload MCP servers
- `/config` — Read or update global configuration
- `/update` — Update agentj and exit
- `/model` — Choose primary or subagent models
- `/cost` — Show foreground token usage and estimated cost
- `/build` — Switch to build mode and implement the plan
- `/jobs` — Inspect background jobs, or `/jobs abort <id>`
- `/undo` — Revert the agent's last file changes
- `/redo` — Re-apply reverted changes
- `/clear` — Clear the transcript view
- `/quit` — End the session

## Input & keys

- & <task> — run as a background job
- @path/to/file — attach file contents · Ctrl+V — paste copied files
- Tab/Enter — complete a shown command · Tab — toggle plan/build otherwise
- Esc — dismiss suggestions / dequeue waiting message / interrupt turn · Ctrl+C×2 — quit
