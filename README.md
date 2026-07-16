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
bun run agentj                                  # local cwd; prompts, plans, then waits for approval
bun run dev                                     # same local-first entrypoint for development
bun run agentj -- "add a --json flag"           # edits and validates the actual checkout
bun run agentj -- sandbox "add a --json flag"   # isolated Microsandbox/worktree
bun run agentj -- --resume <session-id>          # resume persisted task/plan/feedback state
./bin/agentj config set agent.llm.model gpt-5.6-sol
./bin/agentj config set agent.tools.subagents.concurrency 3
./bin/agentj config set agent.tools.subagents.model gpt-5.6-luna  # tier-route fan-out work
./bin/agentj config add sandbox.bootstrap "apt-get install -y gh"
./bin/aj config set --secret providers.azure.api_key
./bin/agentj config delete providers.azure.api_key
./bin/agentj eval
./bin/agentj eval report
./bin/agentj eval selfcheck
./bin/agentj --help
```

The task is a single positional argument — shell-quote multi-word tasks. Bare invocation asks for
the initial task. AgentJ investigates first and presents a plan; feedback revises that plan, while an
explicit `proceed`, `build it`, `implement it`, `implement the plan`, `go ahead`, or `approved`
starts implementation. Ambiguous replies remain in planning.

Interactive task and feedback prompts support:

- Shift+Return for a newline; Return submits.
- Option+Left/Right to move by word and Option+Backspace/Delete to delete by word.
- Cmd+Left/Right to move to the current line boundary and Cmd+Backspace/Delete to delete to it.
- Home/End and Ctrl+A/E are line-movement fallbacks; Ctrl+U/K are line-deletion fallbacks.
- Esc+B/F moves by word, while Esc+Backspace and Esc+D delete the previous/next word.

Modifier encodings vary by terminal. Shift+Return and Cmd shortcuts require a terminal with a
modifier-aware keyboard protocol (such as CSI-u) or equivalent key mappings when those combinations
would otherwise be sent as ordinary Return, arrow, Backspace, or Delete keys.

Local mode operates directly on the caller's Git checkout, so validated changes are immediately
available to host tools. Sandbox mode uses an isolated worktree. Session task, plan, feedback, phase,
and workspace mode are persisted for `--resume`. If interactive input is unavailable, AgentJ prints
the plan and exits without building. The output remains a line-oriented transcript:

- **Sandbox** — configured image and bootstrap command count, shown before setup starts.
- **Bootstrap** — completion or a safely redacted setup failure. An empty bootstrap prints a reminder.
- **Prompt** — the task as received.
- **Session** — worktree id, branch, and base commit.
- **Tool** — every tool call, with payloads safely truncated.
- **Tool result** — shown only when the runner forwards a relevant result (e.g. `run_subagents`).
- **Plan** — the current draft; subsequent feedback produces a revised plan.
- **Build** — shown only after explicit approval.
- **Result** — the builder's final answer.
- **Commit** — the commit SHA and message, or "no changes" if nothing was produced.

AgentJ accepts a build as successful only when the builder returns a structured completion report,
no tool failed, and at least one claimed passing validation command was observed. A blocked build
with changes is committed to the session branch as an `agentj recovery` commit instead of being
reported as shipped; the transcript prints the branch and recovery SHA.

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
./bin/agentj config add project.setup "bun install --frozen-lockfile"
./bin/agentj config get sandbox.bootstrap
./bin/agentj config remove sandbox.bootstrap "apt-get install -y --no-install-recommends gh"
./bin/agentj config delete sandbox.bootstrap
```

`sandbox.bootstrap` commands run in order after the sandbox starts and before AgentJ creates a
session worktree. They are persisted configuration, so never put credentials in them.
At the start of every interactive run, AgentJ prints the sandbox image and configured bootstrap
command count. Command text and output are not printed because setup may contain sensitive values.
`project.setup` commands run from the resolved workspace root after local workspace selection or
sandbox worktree creation and before any model call. Use this phase for locked dependency installs.
`llm.model` remains a compatibility alias that also selects its provider.

`session.base` defaults to `auto`. AgentJ fetches the remote default branch best-effort and compares
it with the matching local branch. It uses whichever ref is a descendant of the other; if the
histories diverge, it uses the shared `origin/<default>` baseline and prints a warning. Set an
explicit ref such as `main`, `head`, or `remote-default` to override that policy. This policy applies
to sandbox worktrees; local mode uses the caller's current checkout exactly as it exists.

`core/agentj.json` remains a project/bundled override layer and never needs a secret:

```json
{
  "sandbox": {
    "bootstrap": [
      "apt-get update && apt-get install -y --no-install-recommends unzip",
      "bash -o pipefail -c 'curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s \"bun-v1.3.14\"'"
    ]
  },
  "project": {
    "setup": ["bun install --frozen-lockfile"]
  },
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

- **Built-in tools:** builders receive `bash`, `readFile`, `writeFile`, `edit`, `grep`, `glob`, and
  `run_subagents`. Planners receive confined `readFile`, `grep`, `glob`, and a read-only
  `run_subagents`; planning workers cannot delegate recursively.
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
  - Before local or sandbox delegation, AgentJ snapshots the parent's current filesystem through a
    temporary Git index, so dirty parent changes are visible to every child without altering the real
    index. Successful child commits are composed in task order and applied back as one checked patch.
- **Adaptive planning DAG** — the planner's `run_subagents` groups read-only workers into numbered
  serial lanes. Independent ready lanes run concurrently; dependent lanes wait for prerequisite
  lanes. Interactive terminals show live worker state and elapsed time:

  ```text
  Subagents: 2/4 finished · elapsed 4.8s
  1  Repository research
    ✓ 1.1 map modules  1.8s
    ◐ 1.2 inspect metrics  3.0s
  2  Command design · waits on: 1
    · 2.1 design command
  ```
- **Purpose-specific prompts** — planner, planning-worker, and builder instructions compose with the
  existing model-family profiles; planning purpose never receives mutation tools.

## Architecture

```
core/
  agent-loop.ts              # sole composition root: selects all production adapters and runs CLI
  lib/
    app/                     # multi-turn conversation and one-shot orchestration services
    agent/                   # purpose-specific tool assembly and subagent delegation
      delegate.ts            # run_subagents tool: parallel isolated-worktree child agents
      planning-delegate.ts   # planner run_subagents: bounded read-only serial-lane DAG
    cli/                     # cmd-ts command parsing and exit-code mapping
    config/                  # config loading and validation
    llm/                     # model client and tool-calling runtime
    prompt/                  # pure model-profile and agent-purpose prompt assembly
    sandbox/                 # microsandbox adapter for confined command execution
    scm/                     # git primitives (branch, worktree, commit, safe cleanup)
    session/                 # session lifecycle: branch/worktree creation and child-lane finalization
    tools/                   # built-in tool definitions (files, search, bash)
    tui/                     # multiline prompt editor and line-oriented transcript renderer
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
