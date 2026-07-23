# Slash commands & keys

The same list `/help` prints in-session, generated from the registry so it always matches your version.

## Slash commands

| command | what it does |
|---|---|
| `/build` | switch to build mode and implement the plan so far |
| `/model [primary\|subagents]` | choose a provider and model |
| `/config get\|set\|delete` | read or update global configuration |
| `/mcp` | manage and reload MCP servers |
| `/jobs` | inspect background jobs (`/jobs abort <id>`) |
| `/undo` · `/redo` | step the agent's file changes through git snapshots |
| `/cost` | foreground token usage and estimated cost |
| `/activity` | completed tool activity for this session |
| `/todos` | show all session todos |
| `/compact` | compact old conversation and tool history |
| `/clear` | start a fresh conversation context |
| `/update [next\|latest]` | update glorious and exit |
| `/help` · `/quit` | list commands and keys · end the session |

## Keys

- **Tab** — complete a shown suggestion, or toggle plan/build otherwise
- **Enter** — send (**Shift+Return** = newline); messages typed mid-turn queue
- **Esc** — dismiss suggestions / dequeue the newest waiting message / interrupt the turn (the session survives; the model is told it was cut short)
- **Ctrl+C** — clear input; interrupt on empty input; double-press quits
- **↑/↓** or **Ctrl+P/N** — pick a suggestion, or browse recent prompts from an empty editor
- **`& task`** — run as a [background job](/jobs)
- **`@path`** — attach file contents (images `.png/.jpg/.gif/.webp` are sent as vision); **Ctrl+V** pastes copied files or screenshots

Full editor motions (word hop, line bounds, `Shift+Return`) need a modifier-aware terminal protocol (CSI-u — kitty, WezTerm, Ghostty, or mapped keys in iTerm2). Home/End, Ctrl+A/E/U/K, and Esc+B/F/D fallbacks work in any terminal.
