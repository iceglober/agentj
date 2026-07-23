# Quickstart

## Install

```sh
bun add --global @glrs-dev/glorious@next
```

Requires [Bun](https://bun.sh) ≥ 1.2 and git. See [install](/install).

## Set the model key

```sh
glorious config set --secret agent.llm.providers.azure.apiKey
```

Stored in the OS keychain.

## Open a session

From inside a git repo:

```sh
glorious
```

Starts in [plan mode](/modes) — read-only. **Tab** or **`/build`** switches to build mode.

## One-shot

```sh
glorious run "add a --json flag to the export command"
glorious run --plan "where is rate limiting enforced?"
```

## Undo

`/undo` and `/redo` step file changes through git snapshots. Build-mode tools are gated by [permissions](/permissions).

## Next

- [modes](/modes)
- [cli](/cli)
- [commands](/commands)
- [config](/config)
