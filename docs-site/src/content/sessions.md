# Sessions

One JSONL log per session under `$XDG_STATE_HOME/glorious/chats/`. A torn final line is skipped on load.

## Resume

```sh
glorious --continue        # newest session for this project
glorious --resume <id>
```

Restores the conversation, the model's tool-call memory, the todo list, and recent turns.

## Todos

The agent maintains a list with `update_todos`; visible in the live region, cleared by `/clear`, printed by `/todos`. Persists across resume.

## Context

History compacts as a request nears the model's input limit. `/compact` on demand; `/clear` resets. Tune with `agent.context.*` in [config](/config).
