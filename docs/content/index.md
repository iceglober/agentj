# glorious

A terminal coding agent. It runs as a persistent chat session in your repo — you talk, it reads and edits files, runs commands, and fans out parallel subagents, with **plan** and **build** modes you toggle with Tab or `/build`. It is host-first and gated by a permission system; git plus a built-in undo are the safety net.

## Quickstart

Install (you need [Bun](https://bun.sh) and git), then set your model provider key once — it goes to the OS keychain, never plaintext:

```
bun add --global @glrs-dev/glorious@next
glorious config set --secret providers.azure.api_key
```

Start a session in any git repository:

```
glorious
```

You begin in **plan mode**: the agent's tools are read-only, so it investigates, fans out research subagents, and proposes a plan without changing anything. Press **Tab** to switch to **build mode** (full tools), or enter **`/build`** to switch and have it implement what the conversation agreed on. That is the whole loop — talk, plan, build. The interactive primary agent can also ask focused structured questions with described choices, multi-select answers, or free text; one-shot runs, background jobs, and subagents cannot. Type `/help` in a session to see every command and key.

:::details Resume a session, or run one-shot from a script

```
glorious --continue                          # reopen the newest session for this project
glorious --resume <id>                        # reopen a specific session by id
glorious run "add a --json flag"              # one task, build mode, then exit
glorious run --plan "how does auth work?"     # one task, read-only
glorious run --allow-all "fix the tests"      # one task; permission asks auto-resolve to allow
```

`glorious update --channel next` updates an installed CLI; `glorious --help` lists the full command line.
:::

:::details Change models, tiers, or permissions

Settings layer from `~/.config/glorious/config.json`, then `.glorious/config.json`, then `.glorious/config.local.json` in the current Git worktree. The legacy `~/.config/glorious/config.json` is read only when the canonical global file is absent. Use the `config` subcommand to edit canonical global settings:

```
glorious config set agent.llm.model gpt-5.6-luna               # default; cost-efficient primary
glorious config set agent.tools.subagents.model gpt-5.6-luna   # explicit fan-out override
glorious config get agent.llm.model
```

Every key and its default is in the Configuration reference below.
:::
