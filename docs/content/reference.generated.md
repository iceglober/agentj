## Commands & keys

In-session slash commands and key bindings — the same list `/help` prints, generated from the registry so it always matches your version.

:::details Show every slash command and key binding

### Slash commands

- `/help` — List commands and keys
- `/mcp` — Manage and reload MCP servers
- `/config` — Read or update global configuration
- `/update` — Update agentj and exit
- `/model` — Choose primary or subagent models
- `/cost` — Show foreground token usage and estimated cost
- `/activity` — Show completed tool activity for this session
- `/todos` — Show all session todos
- `/build` — Switch to build mode and implement the plan
- `/jobs` — Inspect background jobs, or `/jobs abort <id>`
- `/undo` — Revert the agent's last file changes
- `/redo` — Re-apply reverted changes
- `/clear` — Start a fresh conversation context
- `/compact` — Compact old conversation and tool history
- `/quit` — End the session

### Input & keys

- & <task> — run as a background job
- @path/to/file — attach file contents · Ctrl+V — paste copied files
- Tab/Enter — complete a shown command · Tab — toggle plan/build otherwise
- Esc — dismiss suggestions / dequeue waiting message / interrupt turn · Ctrl+C×2 — quit

:::
