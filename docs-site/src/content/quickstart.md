# Quickstart

Zero to a working session in two minutes.

## Install

```sh
bun add --global @glrs-dev/glorious@next
```

Requires [Bun](https://bun.sh) ≥ 1.2 and git. See [install](/install) for the bootstrap script and platform notes.

## Set your model key

Glorious talks to models through Azure AI Foundry. Store the key once — it lives in your OS keychain, never in a config file:

```sh
glorious config set --secret agent.llm.providers.azure.apiKey
```

## Open a session

From inside any git repo:

```sh
glorious
```

You land in **plan mode**: the agent can read, search, and fan out research, but it cannot change a single file. Ask it anything:

> how does auth work in this codebase?

When you're ready to make changes, press **Tab** to switch to **build mode**, or type **`/build`** to switch and immediately implement what you just discussed. See [modes](/modes).

## One-shot, no chat

```sh
glorious run "add a --json flag to the export command"
glorious run --plan "where is rate limiting enforced?"   # read-only
```

## The safety net

Every file change the agent makes is snapshotted in git behind the scenes. `/undo` and `/redo` step through them without touching your HEAD, index, or branch. Build-mode actions are gated by [permissions](/permissions) you control.

## Next

- [modes](/modes) — the plan/build mental model
- [cli](/cli) — every command and flag
- [commands](/commands) — in-session slash commands and keys
- [config](/config) — models, permissions, tools
