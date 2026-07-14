# agentj

A terminal coding agent — same category as Claude Code and Opencode. It reads and writes files in
your repo, runs shell commands, and calls a model in a loop until the task is done. It works in an
isolated git worktree, and **you** own git as the safety net.

The implementation lives in [`core/`](core/) — a Bun TypeScript agent with a sandboxed tool runtime.

## Requirements

- **[Bun](https://bun.sh)** — the runtime. Install once; no separate build step.
- **A model provider.** Wired: **Azure AI Foundry** and any **OpenAI-compatible** endpoint (`custom`).
- **git** — used for worktree isolation and to scope `glob`/`grep` to non-ignored files.

## Run it

```sh
git clone git@github.com:iceglober/agentj.git && cd agentj
```

Three ways to start a task:

```sh
bun run agentj                          # prompts once for a task, then runs
bun run agentj -- "add a --json flag"   # runs the task directly (one-shot)
bun run agentj -- --help                # prints help and exits
```

The task is a single positional argument — shell-quote multi-word tasks. Bare invocation asks once
through a text prompt; Ctrl+C at the prompt exits cleanly before any sandbox or model work starts.

AgentJ runs one task, then exits. It is not a multi-turn chat or fullscreen application. The output
is a line-oriented transcript:

- **Prompt** — the task as received.
- **Session** — worktree id, branch, and base commit.
- **Tool** — every tool call, with payloads safely truncated.
- **Tool result** — shown only when the runner forwards a relevant result (e.g. `run_subagents`).
- **Result** — the agent's final answer.
- **Commit** — the commit SHA and message, or "no changes" if nothing was produced.

Ctrl+C during generation aborts the run, skips the commit, and exits with code 130. Generation and
commit failures exit with code 1 and print recovery details (session path and branch).

**Permissions are auto** — it edits and runs commands without prompting; you own git.

## Configuration

Provider and model are configured in `core/agentj.json`:

```json
{
  "agent": {
    "llm": {
      "model": "gpt-5.6-sol",
      "providers": {
        "azure": {
          "resourceName": "kayn-default-foundry-resource"
        }
      }
    }
  }
}
```

Set the API key via environment:

```sh
export AZURE_FOUNDRY_API_KEY=...
# or
export AZURE_API_KEY=...
```

## What it can do

- **Built-in tools:** `bash`, `readFile`, `writeFile`, `edit`, `grep`, `glob`, `run_subagents`.
  Structured file, edit, and search paths are confined to the session worktree root; `bash` starts
  there but is a powerful shell — it is not a security boundary.
- **Autonomous subagents** — `run_subagents` delegates tasks to parallel child agents, each in its own
  isolated git worktree branched from the parent session's current commit. Every child runs with tools
  bound only to its worktree root.
  - **Changed lanes** commit their changes, remove the temporary worktree, preserve the branch, and
    return branch + commit + result metadata.
  - **Clean lanes** (no changes) remove their worktree and disposable branch.
  - **Failed, panicked, or aborted lanes** preserve their worktree and branch, and report recovery
    metadata (path, branch, head commit, reason) so no work is lost.
  - Child agents cannot delegate recursively.
  - Concurrency is bounded at 2.
- **SPEAR prompt** — Scope → Plan → Execute → Assess → Resolve, with branch-first safety and
  "prove it with hard evidence" completion.

## Architecture

```
core/
  agent-loop.ts              # thin entrypoint: wires production deps, runs cmd-ts CLI
  lib/
    app/                     # one-task orchestration and structured outcomes
    agent/                   # agent loop, tool assembly, subagent delegation
      delegate.ts            # run_subagents tool: parallel isolated-worktree child agents
    cli/                     # cmd-ts command parsing and exit-code mapping
    config/                  # config loading and validation
    llm/                     # model client and tool-calling runtime
    prompt/                  # SPEAR prompt assembly
    sandbox/                 # microsandbox adapter for confined command execution
    scm/                     # git primitives (branch, worktree, commit, safe cleanup)
    session/                 # session lifecycle: branch/worktree creation and child-lane finalization
    tools/                   # built-in tool definitions (files, search, bash)
    tui/                     # prompts input adapter and line-oriented transcript renderer
  eval/                      # eval harness: fixture projects + task runner, objectively graded
    run.ts                   # eval entry point
    fixtures/                # fixed test projects
    tasks/                   # task definitions and grading config
```

## Develop

```sh
bun run test                                # all core tests
bun run typecheck                           # strict TypeScript check (noEmit)
bun run eval:selfcheck                      # eval harness self-check (no paid model calls)
```

## License

MIT — see [LICENSE](LICENSE).
