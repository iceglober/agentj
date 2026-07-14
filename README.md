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

The unified command surface is `agentj` (or `aj` after linking/installing the package):

```sh
bun run agentj                                  # prompts once for a task, then runs
bun run agentj -- "add a --json flag"           # runs the task directly (one-shot)
./bin/agentj config set agent.llm.model gpt-5.6-sol
./bin/agentj config add sandbox.bootstrap "apt-get install -y gh"
./bin/aj config set --secret providers.azure.api_key
./bin/agentj config delete providers.azure.api_key
./bin/agentj eval
./bin/agentj eval report
./bin/agentj eval selfcheck
./bin/agentj --help
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

Normal user settings are stored in `~/.config/agentj/config.json`; AgentJ merges defaults, then
that global config, then the supplied project/bundled config. `config get`, `set`, and `delete`
accept every schema-valid non-secret key path; `add` and `remove` operate on array-valued paths.

```sh
./bin/agentj config set agent.llm.model gpt-5.6-sol
./bin/agentj config set sandbox.image ghcr.io/iceglober/agentj-sandbox-base:1
./bin/agentj config add sandbox.bootstrap "apt-get install -y --no-install-recommends gh"
./bin/agentj config get sandbox.bootstrap
./bin/agentj config remove sandbox.bootstrap "apt-get install -y --no-install-recommends gh"
./bin/agentj config delete sandbox.bootstrap
```

`sandbox.bootstrap` commands run in order after the sandbox starts and before AgentJ creates a
session worktree. They are persisted configuration, so never put credentials in them.
`llm.model` remains a compatibility alias that also selects its provider.

`core/agentj.json` remains a project/bundled override layer and never needs a secret:

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

The config file never contains an API key. Credentials are resolved in this order:

1. `AZURE_FOUNDRY_API_KEY` environment variable
2. `AZURE_API_KEY` environment variable
3. OS keychain (see below)

Environment variables are the explicit path for CI and automation. The keychain is the
convenient path for interactive use — store once, never type again.

### Storing credentials in the OS keychain

```sh
./bin/agentj config set --secret providers.azure.api_key
./bin/agentj config delete providers.azure.api_key
```

`bun run agentj:secrets -- …` remains a deprecated compatibility shim for one release.

The key is stored globally in the host OS keychain (macOS Keychain, Windows Credential
Manager, Linux `libsecret`). Secret values are never printed, logged, or passed as
command-line arguments. If the secure store is unavailable, the command fails with a clear
message — there is no plaintext fallback file.

### Azure prompt caching

AgentJ constructs requests to maximize Azure's automatic prompt caching:

- The system prompt prefix is stable across runs.
- Tool definitions are sent in deterministic sorted order.

These choices let Azure's provider-side cache recognize repeated prefixes and tool schemas
without AgentJ managing cache keys. Caching is provider-managed — AgentJ does not control
whether a given request hits the cache.

Token usage includes cache detail when the provider reports it:

| Field | Meaning |
|---|---|
| `inputTokens` | Total input tokens |
| `noCacheInputTokens` | Input tokens that missed the cache |
| `cacheReadInputTokens` | Input tokens served from cache |
| `cacheWriteInputTokens` | Input tokens written to cache |

These are token counts, not USD. AgentJ does not compute monetary cost — it has no
deployment pricing catalog.

### Optional OpenTelemetry metrics

Set `AGENTJ_OTEL_METRICS=1` to enable metrics export:

```sh
AGENTJ_OTEL_METRICS=1 bun run agentj -- "your task"
```

When enabled, AgentJ records aggregate counters and histograms through the OpenTelemetry
API. You must configure your own OTel provider and exporter — AgentJ bundles no collector,
exporter, or network configuration.

Metrics recorded (all per `provider` / `model` / `outcome`):

| Instrument | Type | Unit |
|---|---|---|
| `agentj.llm.duration` | Histogram | ms |
| `agentj.llm.tokens.input` | Counter | tokens |
| `agentj.llm.tokens.no_cache` | Counter | tokens |
| `agentj.llm.tokens.cache_read` | Counter | tokens |
| `agentj.llm.tokens.cache_write` | Counter | tokens |
| `agentj.llm.tokens.output` | Counter | tokens |
| `agentj.llm.tokens.total` | Counter | tokens |
| `agentj.llm.cache_read_ratio` | Histogram | ratio |

**What is never exported:** prompts, model outputs, tool inputs, API keys, file paths,
project names, or any other content. Attributes are restricted to the three low-cardinality
labels above. Unknown or free-form attribute keys are rejected. A metrics failure never
affects task success — the sink fails closed.

When `AGENTJ_OTEL_METRICS` is unset or `0`, the metrics path is a no-op with zero
overhead.

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
