# Permissions & safety

Glorious runs **host-first**: tools execute in your real checkout, not a sandbox. That speed is made safe by gating every mutating tool at the tool layer, plus git-backed undo.

## Never gated

- Reading and searching the repo — always allowed.
- Plan mode — has no mutating tools at all.

## Gated (build mode)

```sh
glorious config set permissions.edit allow          # allow | ask | deny   (file edits)
glorious config set permissions.web  ask            # outbound search + fetch
glorious config set permissions.bash.default ask    # unlisted commands
glorious config add permissions.bash.allow "git *"  # literal prefix, optional trailing *
glorious config add permissions.bash.deny  "git push*"
glorious config add permissions.mcp.allow  "mcp_github_search_*"
```

## What an ask looks like

Before an `ask` command runs, the complete, terminal-escaped command is printed to the transcript, then inline controls appear:

```
[y]es once · [a]lways this session · [n]o
```

Concurrent asks queue. A session-wide "always" applies only to `ask` outcomes — a configured `deny` stays authoritative. A denial is returned to the model as a tool result, so the agent adapts instead of crashing the turn.

## Non-interactive runs

`glorious run` has no TTY. Asks resolve to **deny with a notice** unless you pass `--allow-all`, which resolves asks to allow (configured denies still hold).

## Undo

Every file change is snapshotted to a dedicated git ref namespace. `/undo` and `/redo` move through those snapshots via temp-index commits and verified binary patches — your HEAD, index, and branch are never touched.
