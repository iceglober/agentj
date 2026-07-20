# agentj

A terminal coding agent. It runs as a persistent chat session in your repo — you talk, it reads and edits files, runs commands, and fans out parallel subagents, with **plan** and **build** modes you toggle with Tab or `/build`. It is host-first and gated by a permission system; git plus a built-in undo are the safety net.

## Quickstart

Install (you need [Bun](https://bun.sh) and git), then set your model provider key once — it goes to the OS keychain, never plaintext:

```
bun add --global @glrs-dev/aj@next
agentj config set --secret providers.azure.api_key
```

Start a session in any git repository:

```
agentj
```

You begin in **plan mode**: the agent's tools are read-only, so it investigates, fans out research subagents, and proposes a plan without changing anything. Press **Tab** to switch to **build mode** (full tools), or enter **`/build`** to switch and have it implement what the conversation agreed on. That is the whole loop — talk, plan, build. Type `/help` in a session to see every command and key.

:::details Resume a session, or run one-shot from a script

```
agentj --continue                          # reopen the newest session for this project
agentj --resume <id>                        # reopen a specific session by id
agentj run "add a --json flag"              # one task, build mode, then exit
agentj run --plan "how does auth work?"     # one task, read-only
agentj run --allow-all "fix the tests"      # one task; permission asks auto-resolve to allow
```

`agentj update --channel next` updates an installed CLI; `agentj --help` lists the full command line.
:::

:::details Change models, tiers, or permissions

Settings layer from `~/.config/aj/config.json`, then `.aj/config.json`, then `.aj/config.local.json` in the current Git worktree. The legacy `~/.config/agentj/config.json` is read only when the canonical global file is absent. Use the `config` subcommand to edit canonical global settings:

```
agentj config set agent.llm.model gpt-5.6-sol
agentj config set agent.tools.subagents.model gpt-5.6-luna   # route fan-out to a cheaper tier
agentj config get agent.llm.model
```

Every key and its default is in the Configuration reference below.
:::
