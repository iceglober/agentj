# agentj

A terminal coding agent — same category as Claude Code and OpenCode. It runs as a persistent chat
session in your repo: you talk, it reads and edits files, runs commands, and fans out parallel
subagents, with **plan** and **build** modes you toggle with Tab. Host-first, gated by a permission
system; git (plus built-in undo) is the safety net.

The implementation lives in [`core/`](core/) — a Bun TypeScript agent.

## Requirements

- **[Bun](https://bun.sh)** — the runtime. Install once; no separate build step.
- **A model provider** — wired: **Azure AI Foundry**.
- **git** — sessions run inside a git worktree; undo, subagent isolation, and search scoping use it.

## Run it

```sh
git clone git@github.com:iceglober/agentj.git && cd agentj
```

```sh
bun run agentj                         # open a chat session in this repo (plan mode)
bun run agentj -- --continue           # reopen the newest session for this project
bun run agentj -- --resume <id>        # reopen a specific session
bun run agentj -- run "add a --json flag"              # non-interactive one-shot (build)
bun run agentj -- run --plan "how does auth work?"     # non-interactive, read-only
bun run agentj -- run --allow-all "fix the tests"      # asks auto-resolve to allow
./bin/agentj config set agent.llm.model gpt-5.6-sol
./bin/agentj config set agent.tools.subagents.model gpt-5.6-luna  # tier-route fan-out work
./bin/agentj config set --secret providers.azure.api_key
./bin/agentj eval | eval report | eval selfcheck
./bin/agentj --help
```

## The chat session

You start in **plan mode**: the agent's tools are read-only — it can investigate, fan out research
subagents, and present a plan, but it cannot edit anything. Press **Tab** to switch to **build
mode** (full tools). Tab is the approval gesture: there is no magic approval phrase.

Keys and commands:

- **Tab** — toggle plan/build (applies at the next turn if one is running).
- **Esc** — interrupt the running turn. The session survives; the model is told it was cut short.
- **Ctrl+C** — clear the input; on empty input it interrupts, and a double press quits.
- **Enter** — send. **Shift+Return** — newline. Outer whitespace is trimmed when routing a
  message; internal blank lines are preserved. Messages typed mid-turn are queued.
- **↑/↓** or **Ctrl+P/N** — browse recent submitted prompts from an empty editor.
- **`& <task>`** — run the task as a background job in the current mode. Jobs run in their own
  worktree (build) or read-only (plan), never race your checkout, and report into the transcript
  and the next turn. `/jobs` lists them; `/jobs abort <id>` stops one.
- **`@path/to/file`** — attach a file's contents to your message.
- **`/help /jobs /undo /redo /clear /quit`** — built-in commands. `/undo` and `/redo` step the
  agent's file changes through git snapshots without touching your HEAD, index, or branch.

Editor shortcuts: Option+←/→ word hop, Option+Backspace/Delete word delete, Cmd+←/→ line bounds,
Cmd+Backspace/Delete delete to bound; Home/End, Ctrl+A/E/U/K, and Esc+B/F/D fallbacks work in any
terminal. Shift+Return and Cmd combinations need a modifier-aware terminal protocol (CSI-u — kitty,
WezTerm, Ghostty, or mapped keys in iTerm2).

## Permissions

Host-first execution is gated at the tool layer. Read/search tools are never gated; plan mode has
no mutating tools at all. In build mode:

```sh
./bin/agentj config set permissions.edit allow            # allow | ask | deny (default allow)
./bin/agentj config set permissions.bash.default ask      # unlisted commands ask
./bin/agentj config add permissions.bash.allow "git *"    # literal prefix, optional trailing *
./bin/agentj config add permissions.bash.deny "git push*"
```

The complete, terminal-escaped request is printed into the transcript before the inline controls
(`[y]es once · [a]lways this session · [n]o`) appear; concurrent asks are queued. Session-wide
approval applies only to policy outcomes of `ask`; configured denies remain authoritative.
In `agentj run` there is no TTY: asks resolve to deny with a notice unless `--allow-all` is passed. A
denial is returned to the model as a tool result, so it adapts instead of crashing the turn.

## Parallel subagents

In both modes the agent has `run_subagents`: a task DAG (`waitsOn` between tasks) executed with
bounded concurrency. Plan mode fans out read-only researchers; build mode gives each child an
isolated git worktree and integrates the results back as a batch — a child failure preserves its
branch instead of losing work. Running DAG state stays in the live region, then a final task summary
is retained in the transcript. `agent.tools.subagents.model` routes children to a cheaper tier.

## Sessions and persistence

Every session appends to one JSONL log under `$XDG_STATE_HOME/agentj/chats/`. `--continue` /
`--resume <id>` restore the conversation (including the model's tool-call memory) and replay
recent turns. Crash-safe by construction: a torn final line is skipped on load.

## Evals

`core/eval/` holds the eval harness: fixture-based tasks (Python and TypeScript), deterministic
graders plus trajectory/report checks, seeded-defect and punch-list task sources, and a selfcheck
gate proving every task solvable and falsifiable. Eval runs use the Microsandbox adapter; the
interactive agent itself is host-first. See `bun run agentj -- eval --help`.

## Development

```sh
bun test core        # unit tests
bun run typecheck
bun run check        # biome lint + format
bun run agentj -- eval selfcheck   # model-free eval QA gate
```
