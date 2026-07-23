# Sessions & persistence

Every session appends to one JSONL log under `$XDG_STATE_HOME/glorious/chats/` (typically `~/.local/state/glorious/chats/`). It's crash-safe by construction — a torn final line is skipped on load.

## Resume

```sh
glorious --continue        # newest session for this project
glorious --resume <id>     # a specific session
```

Resuming restores the conversation, the model's tool-call memory, the todo list, and recent turns.

## Todos

For multi-step work the agent maintains a todo list with `update_todos`. It stays visible in the terminal live region and clears with `/clear`. `/todos` prints the full list; it persists across resume.

## Context management

Interactive history compacts automatically as a request approaches the model's input limit; `/compact` compacts on demand and `/clear` starts a fresh context. Tune the thresholds with `agent.context.*` in [config](/config).
