# AGENTS.md — agentj-rs

## Scope
`agentj-rs/` is the product crate. Build and test it from this directory with Cargo; root-level Bun files are wrappers around these commands.

## Entry points and module map
- `src/main.rs` — CLI entry, config/model preflight, MCP startup, routes to:
  - default full-screen TUI
  - `--once <task>` headless execution
  - `mcp list|login|logout`
- `src/agent/` — non-streaming model/tool loop:
  - `mod.rs` — `Session` + `run_turn`, the loop skeleton (tool replay, events, job nudges).
  - `delegate.rs` — the `delegate` subagent fan-out (parallel sub-tasks, result capping).
  - `supervisor.rs` — `Supervisor`: SPEAR/ASSESS/RESOLVE gates, step-budget/frontier nudges.
  - `compact.rs` — context compaction (see conventions below).
- `src/tools/` — built-in tools + MCP passthrough:
  - `mod.rs` — `ToolOutcome` + the `Tools` registry/dispatch.
  - `files.rs` (`read_file`/`write_file`/`edit_file`/`edit_lines`/`list_dir`), `search.rs` (`glob`/`grep`), `shell.rs` (`bash`/`job_start`), `webcheck.rs` (`web_check`).
  - `paths.rs` (`safe_resolve` repo confinement), `stamps.rs` (`ReadStamps` edit-staleness guard), `spec.rs` (the schemas advertised to the model).
- `src/tui/`
  - `app/` — UI state transitions; returns `AppEffect` for anything async. `mod.rs` holds `App`; submodules: `input`, `update`, `msg`, `selection`, `setup`, `tokens`, `tray`.
  - `mod.rs` — outer event loop / async orchestration.
  - `view/` — rendering. `mod.rs` is the frame composer; submodules: `transcript`, `input`, `status`, `tray`, `modal`.
  - `editor.rs`, `keymap.rs`, `markdown.rs`, `theme.rs` — input/render helpers.
  - `knowledge.rs` — `/init` and `/knowledge` snapshot/diff workflow.
- `src/provider/`, `src/model.rs` — provider abstraction and OpenAI-compatible client; Azure/custom are wired, Vertex/Anthropic staged.
- `src/mcp/` — `.mcp.json` loading/merge and RMCP client.
- `src/rekey.rs` — `/task` worktree re-key git flow.
- `src/jobs.rs` — background command manager and nudge queue.
- `src/exec.rs` — process-group command runner.
- `tests/pty_input.rs` — PTY integration coverage for interactive input behavior.

## Local conventions
- Non-streaming loop is intentional; do not switch behavior casually.
- Keep TUI boundaries intact:
  - state/update logic in `tui/app/`
  - await/orchestration in `tui/mod.rs`
  - drawing in `tui/view/`
- `delegate` is a first-class feature here:
  - parent interception and fan-out are in `src/agent/delegate.rs`
  - the subagent prompt is assembled in `src/prompt.rs` (`subagent_identity`)
  - depth is capped; subagents do not re-delegate.
- Tool calls return user/model-readable text plus structured success (`ToolOutcome { text, ok }`); do not reintroduce ad hoc error sniffing.
- File tools must stay confined to repo-relative safe paths; preserve `safe_resolve` semantics.
- Command execution and background jobs must keep process-group kill behavior so interrupts/timeouts kill descendants.
- Config is resolved once at startup (`src/config.rs`); avoid dynamic rereads unless the task explicitly requires it.
- Context compaction elides older already-seen tool-result bodies once a model call's prompt passes `compact_threshold` (`AGENTJ_COMPACT_THRESHOLD`, default 12000, clamped ≤70% of the window). It is an ABSOLUTE token count on purpose: a window-relative rule (70% of a 400k window = 280k) never fires on tasks whose context peaks at ~20k. `keep_recent` (8) tool bodies always stay verbatim and unseen results are never elided (`seen_before` watermark). Scope: this is a safety valve that reclaims context only when the OLD tool results are large — a live A/B confirmed it does NOT dent the many-round-trip token tail (bloat there is accumulation of many small messages, not big old bodies).
- Slash commands are centrally defined in `src/commands.rs`; keep completion/highlighting and execution in sync through that registry.
- Prompt/doctrine tuning law (replicated 3-4× in the 2026-07 eval study, `docs/research-long-horizon-2026-07.md`): never RESTRICT what the model may read — eliding exploration context, forbidding re-reads, span-only reads, and one-stroke edit rules all regressed, usually inverting on their own target task. Sharpen STRATEGY instead: where to search first (broad-then-narrow), what a delegation brief carries (located paths + return shape), what a report quotes (verbatim identifiers). Also: a 33-run eval sweep has a ±5-pass noise floor — pool sweeps or demand per-task mechanism evidence before trusting a delta.

## Verified commands
Ran from repo root against this crate:
```sh
cargo build --release --manifest-path agentj-rs/Cargo.toml
cargo test --manifest-path agentj-rs/Cargo.toml
```

Useful crate-local equivalents:
```sh
cd agentj-rs
cargo build
cargo run -- --help
cargo run -- --once "add a --json flag and run the tests"
cargo run
```

## Verification evidence
- `cargo build --release --manifest-path agentj-rs/Cargo.toml` — passed.
- `cargo test --manifest-path agentj-rs/Cargo.toml` — passed: 94 unit tests + 5 PTY integration tests.
