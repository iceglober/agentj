# AGENTS.md — agentj

Guidance for agents (and humans) working in this repo.

## What this is

`agentj` is a simple, self-contained terminal coding agent — same category as Claude Code / Opencode.
The product is a **Rust crate with a full-screen ratatui UI**, in `agentj-rs/`. It reads/writes files,
runs commands, and calls a model in a loop until the task is done. Guiding principle: **make it work
and keep it small.** (An earlier TypeScript implementation was retired in the Rust cutover; historical
design notes live in `docs/`.)

## How it fits together (`agentj-rs/src/`)

- `main.rs` — CLI entry: flags, the `mcp` subcommand, then `--once` (headless) or the ratatui chat.
  Builds `agent::Session` (llm + tools + `config::Config`) once and threads it through.
- `tui/` — the interactive full-screen UI, split by concern: `app.rs` (the `App` state struct and its
  keystroke/event transitions, which return an `AppEffect` for anything the loop must `.await`),
  `view.rs` (rendering: transcript / subagent panel / status / input, plus the row-count caches),
  `markdown.rs` (CommonMark → styled lines for assistant replies), `editor.rs` (multi-line input
  buffer), `keymap.rs` (pure keystroke → `Action`), `theme.rs` (palette), and `mod.rs` (the
  `tokio::select!` event loop + `spawn_turn`).
- `config.rs` — runtime knobs resolved once from the environment (`Config`).
- `agent.rs` — the model loop (`run_turn`). Non-streaming: call the model, run its tool calls, repeat.
  Layered on: **background-job nudging** (drain finished/timeout nudges each iteration; idle-wait only
  when there's nothing else to do), **`delegate`** interception (subagents), and **history-commit
  deltas** — as the turn progresses it emits committed message groups (an assistant reply plus its
  tool replies, atomically) so an interrupted turn keeps whatever already applied.
- `subagent.rs` — the subagent prompt; `delegate` runs sub-tasks in parallel via a `JoinSet` (bounded),
  depth cap 1, emitting structured `Subagent{Start,Progress,End}` events (a panicked sub-task still
  reports a failed end); only results re-enter the parent context.
- `jobs.rs` — `JobManager`: background commands in their own process group, capped output buffers,
  finish/timeout nudges (a `VecDeque` + `Notify`, never locked across `.await`), an atomic
  `has_running`, and `kill_after(watermark)` so an interrupt kills only that turn's jobs.
- `tools.rs` — built-in tools (`read_file`/`write_file`/`edit_file`/`list_dir`/`glob`/`grep`/`bash`),
  the `job_*` tools, MCP routing, and `tool_specs`. `Tools::call` returns a `ToolOutcome { text, ok }`:
  the model still only ever sees `text` (tools never error out of a call), while `ok` lets the UI mark
  failed calls without re-sniffing the string.
- `exec.rs` — the command runner: detached process group so Ctrl-C/timeout kills the whole tree.
- `model.rs` — provider resolution + preflight (azure/custom wired; vertex/anthropic staged), plus a
  `context_window` model table for the UI meter.
- `provider/` — the `Llm` enum + the OpenAI-compatible client; captures `usage` (`TokenUsage`) per call.
- `mcp/` — `.mcp.json` config (`config.rs`, pure + tested) + an `rmcp` client (`client.rs`).
- `prompt.rs` — the SPEAR system prompt. `rekey.rs` — `/task` LRW logic. `util.rs` — shared helpers.
  `commands.rs` / `events.rs`.

## Conventions

- **Self-contained; no runtime dep on `glrs`.** Reimplement small patterns clean, never import.
- **Non-streaming loop on purpose** (Vertex mangles Gemini thought-signatures on streamed tool replay).
- **Permissions are auto** — every tool call proceeds; the user owns git as the safety net.
- **Path confinement** — file tools resolve through `safe_resolve`, rejecting `..`/symlink escapes.
- **Tools never error out** — `Tools::call` returns `ToolOutcome { text, ok }`; the model reads only
  `text` (a failure is a string it can react to), and `ok` is set at the source, not sniffed from it.
- **Branch-first (SPEAR Scope)** — get on the intended branch/PR before changing anything; if you
  can't, STOP and report, never edit the wrong branch.

## Repo conventions

- The product builds with `cargo` (edition 2021). `bin/agentj` / `bin/aj` are bash launchers that build
  the release binary on first run, then exec it.
- `cargo build --release --manifest-path agentj-rs/Cargo.toml` (or `bun run build`);
  `cargo test --manifest-path agentj-rs/Cargo.toml` (or `bun run test`). Keep the build **warning-clean**.
- `test-projects/` is a bun eval harness (`bun test-projects/run.ts`). It drives `bin/agentj --once`.
- Keep additions small and justified — the agent should stay simple enough to reason about in one sitting.
