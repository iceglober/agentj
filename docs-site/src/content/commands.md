# Slash commands & keys

Matches `/help`.

## Slash commands

| command | action |
|---|---|
| `/build` | switch to build mode and implement the plan so far |
| `/model [primary\|subagents]` | choose a provider and model |
| `/config get\|set\|delete` | read or update global configuration |
| `/mcp` | manage and reload MCP servers |
| `/jobs` | inspect background jobs (`/jobs abort <id>`) |
| `/undo` · `/redo` | step file changes through git snapshots |
| `/cost` | foreground token usage and estimated cost |
| `/activity` | completed tool activity for this session |
| `/todos` | show all session todos |
| `/compact` | compact old conversation and tool history |
| `/clear` | fresh conversation context |
| `/update [next\|latest]` | update and exit |
| `/help` · `/quit` | list commands and keys · end the session |

## Keys

- **Tab** — complete a shown suggestion, or toggle plan/build
- **Enter** — send (**Shift+Return** = newline); mid-turn messages queue
- **Esc** — dismiss suggestions / dequeue the newest waiting message / interrupt the turn
- **Ctrl+C** — clear input; interrupt on empty; double-press quits
- **↑/↓** or **Ctrl+P/N** — pick a suggestion, or browse recent prompts from an empty editor
- **`& task`** — run as a [background job](/jobs)
- **`@path`** — attach file contents (images sent as vision); **Ctrl+V** pastes copied files or screenshots

Word/line motions and `Shift+Return` need a modifier-aware terminal (CSI-u: kitty, WezTerm, Ghostty, or mapped iTerm2 keys). Home/End, Ctrl+A/E/U/K, and Esc+B/F/D work in any terminal.
