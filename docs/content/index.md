# agentj

A terminal coding agent. It runs as a persistent chat session in your repo — you talk, it reads and edits files, runs commands, and fans out parallel subagents, with **plan** and **build** modes you toggle with Tab or `/build`. It is host-first and gated by a permission system; git plus a built-in undo are the safety net.

## Requirements

- **[Bun](https://bun.sh)** — the runtime. Install once; there is no separate build step.
- **A model provider** — Azure AI Foundry is wired in.
- **git** — sessions run inside a git worktree; undo, subagent isolation, and search scoping all use it.

## Install

```
bun add --global @glrs-dev/aj@next
```

This puts `agentj` (and the short alias `aj`) on your PATH from the prerelease channel. Update an installed CLI later with `agentj update --channel next`.

Set your provider key once — it is stored in the OS keychain, never in plaintext:

```
agentj config set --secret providers.azure.api_key
```

## Start a session

Run `agentj` inside any git repository:

```
agentj                      # open a chat session in this repo (starts in plan mode)
agentj --continue           # reopen the newest session for this project
agentj --resume <id>        # reopen a specific session by id
```

You begin in **plan mode**: the agent's tools are read-only, so it can investigate, fan out research subagents, and present a plan, but it cannot change anything. Press **Tab** to switch to **build mode** (full tools), or enter **`/build`** to switch and immediately ask it to implement what the conversation agreed on. These are explicit gestures — there is no magic approval phrase.

## One-shot runs

For scripts and CI, run a single task and exit:

```
agentj run "add a --json flag"                  # build mode
agentj run --plan "how does auth work?"         # read-only
agentj run --allow-all "fix the tests"          # permission asks auto-resolve to allow
```

## Configuration

Configuration lives in `~/.config/agentj/config.json` and is edited with the `config` subcommand:

```
agentj config set agent.llm.model gpt-5.6-sol
agentj config set agent.tools.subagents.model gpt-5.6-luna   # route fan-out work to a cheaper tier
agentj config get agent.llm.model
```

Run `agentj --help` for the full command-line surface.

## Reference

The next section lists every in-session slash command and key binding. It is generated from the same registry that powers `/help`, so it always matches the version you are running.
