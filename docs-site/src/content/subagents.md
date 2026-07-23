# Parallel subagents

Glorious fans work out across many agents at once with `run_subagents` — a task DAG (`waitsOn` dependencies) executed at bounded concurrency.

## Plan vs build fan-out

- **Plan mode** — children are read-only researchers. Point five of them at five subsystems and get five reports back.
- **Build mode** — each child gets its own **isolated git worktree**; results integrate back as a batch. A child failure preserves its branch instead of losing the work.

## Watching it

Running DAG state stays live in the terminal region while children work; a final per-task summary is retained in the transcript.

## Route children to a cheaper model

Fan-out is where token cost concentrates, so send children to a cheaper rung of your [ladder](/config):

```sh
glorious config set agent.tools.subagents.tier 2       # a lower ladder tier
glorious config set agent.tools.subagents.concurrency 2 # max running at once
```

Or interactively with **`/model subagents`**, which can also restore primary-model inheritance.

Subagents and background jobs do **not** inherit MCP connections unless a server opts in — see [mcp](/mcp).
