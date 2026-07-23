# Plan & build modes

## Plan mode

Read-only. Reads files, searches the repo, browses the web, fans out research [subagents](/subagents). No edits, no mutating commands, no writes. Default on start.

## Build mode

Full tool set, each gated by [permissions](/permissions).

- **Tab** — toggle plan ⇄ build when no completion is showing.
- **`/build`** — switch and implement the plan and discussion so far.

The active mode is authoritative on every turn.

## Model per mode

```sh
glorious config set agent.llm.modes.plan 0    # ladder tier, 0 = frontier
glorious config set agent.llm.modes.build 1
```

See [config](/config).
