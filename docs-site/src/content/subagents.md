# Parallel subagents

`run_subagents` runs a task DAG (`waitsOn` dependencies) at bounded concurrency.

- **Plan mode** — read-only researchers.
- **Build mode** — each child gets an isolated git worktree; results integrate as a batch. A failed child keeps its branch.

Running state stays in the live region; a per-task summary is retained in the transcript.

## Route children to another model

```sh
glorious config set agent.tools.subagents.tier 2
glorious config set agent.tools.subagents.concurrency 2
```

Or `/model subagents`. Subagents don't inherit MCP unless a server opts in — see [mcp](/mcp).
