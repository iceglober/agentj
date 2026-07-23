# Permissions

Tools execute in your checkout (host-first), gated at the tool layer.

## Never gated

- Repo read and search.
- Plan mode (no mutating tools).

## Gated (build mode)

```sh
glorious config set permissions.edit allow          # allow | ask | deny
glorious config set permissions.web  ask
glorious config set permissions.bash.default ask
glorious config add permissions.bash.allow "git *"  # prefix, optional trailing *
glorious config add permissions.bash.deny  "git push*"
glorious config add permissions.mcp.allow  "mcp_github_search_*"
```

## Asks

The full terminal-escaped command prints before the controls:

```
[y]es once · [a]lways this session · [n]o
```

Concurrent asks queue. "Always" applies to `ask` outcomes only; `deny` always holds. A denial returns to the model as a tool result.

## Non-interactive

`glorious run` resolves asks to deny unless `--allow-all` is passed. Denies still hold.

## Undo

File changes are snapshotted to a git ref namespace. `/undo` and `/redo` move through them without touching HEAD, index, or branch.
