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

AgentJ is a one-shot entry point: it takes a task as a single argument, runs the agent loop in an
isolated worktree, prints the result, commits, and exits. There is no interactive chat mode.

**Permissions are auto** — it edits and runs commands without prompting; you own git.

### From the AgentJ repo

```sh
git clone git@github.com:iceglober/agentj.git && cd agentj
bun run agentj -- "add a --json flag and run the tests"
```

### From your own project

Run AgentJ from any Git project directory by passing the absolute path to `agent-loop.ts`:

```sh
cd /path/to/your-project
bun /absolute/path/to/agentj/core/agent-loop.ts "your task here"
```

**Requirements for external invocation:**

- **The project must be a Git repository.** AgentJ validates this before creating a sandbox or
  calling a model. A non-Git directory fails immediately with a clear error — it will not run
  `git init` in your project.
- **The project directory is bind-mounted** into the sandbox as the source repository. AgentJ
  branches from your project's current Git state and creates an isolated session worktree inside
  the sandbox. All file edits and tool operations happen in that guest worktree — your host
  checkout files are never the normal tool root.
- **Session commits create branches in your project's Git database.** Each run produces a
  `session/<id>` branch in your repo. If the session succeeds, the branch is preserved so you can
  inspect, diff, merge, or discard the changes. Clean sessions (no changes) remove their branch
  automatically.
- **There is no global binary or package installation.** AgentJ runs directly via `bun` with an
  absolute script path. A shell alias or function is the recommended convenience wrapper.

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
  agent-loop.ts              # CLI entry: one-shot headless mode
  lib/
    agent/                   # agent loop, tool assembly, subagent delegation
      delegate.ts            # run_subagents tool: parallel isolated-worktree child agents
    config/                  # config loading and validation
    llm/                     # model client and tool-calling runtime
    prompt/                  # SPEAR prompt assembly
    sandbox/                 # microsandbox adapter for confined command execution
    scm/                     # git primitives (branch, worktree, commit, safe cleanup)
    session/                 # session lifecycle: branch/worktree creation and child-lane finalization
    tools/                   # built-in tool definitions (files, search, bash)
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