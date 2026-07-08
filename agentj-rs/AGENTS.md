# AGENTS.md — agentj-rs

## Scope
`agentj-rs/` is the product crate. Build and test it from this directory with Cargo; root-level Bun files are wrappers around these commands.

## Entry points and module map
- `src/main.rs` — CLI entry, config/model preflight, MCP startup, routes to:
  - default full-screen TUI
  - `--once <task>` headless execution
  - `mcp list|login|logout`
- `src/agent/` — non-streaming model/tool loop:
  - `mod.rs` — `Session` + `run_turn`, the loop skeleton (tool replay, events, job nudges); also `frontier_resume`, the `--resume`/`--continue` first-turn plan re-injection.
  - `delegate.rs` — the `run_subagents` subagent fan-out (parallel sub-tasks, result capping).
  - `agent_type.rs` — the typed subagents (scout/planner/reviewer/executor): each type's role identity + tool allowlist.
  - `compact.rs` — context compaction (see conventions below).
- `src/tools/` — built-in tools + MCP passthrough:
  - `mod.rs` — `ToolOutcome` + the `Tools` registry/dispatch.
  - `files.rs` (`read_file`/`write_file`/`edit_file`/`edit_lines`/`list_dir`), `search.rs` (`glob`/`grep`), `shell.rs` (`bash`/`job_start`).
  - `paths.rs` (`safe_resolve` repo confinement), `stamps.rs` (`ReadStamps` edit-staleness guard), `spec.rs` (the schemas advertised to the model).
- `src/tui/`
  - `app/` — UI state transitions; returns `AppEffect` for anything async. `mod.rs` holds `App`; submodules: `input`, `update`, `msg`, `selection`, `setup`, `tokens`, `tray`.
  - `mod.rs` — outer event loop / async orchestration.
  - `view/` — rendering. `mod.rs` is the frame composer; submodules: `transcript`, `input`, `status`, `tray`, `modal`.
  - Transcript is the "Cards" style: each line carries a `LineKind` (Plain/User/Assistant/Tool/Note/Thinking); `visible_transcript_rows` draws a per-block **type label** (`you/agentj/tool/note/thinking`, reserved `LABEL_W` column, once on a block's first row) then decorates User/Assistant lines as tinted bands with a `▌` left bar (`GUTTER`). Tool/note render plainly; `Thinking` is the model's reasoning (from `AssistantTurn.reasoning`, provider `reasoning_content`/`reasoning`, via `AgentEvent::Thinking` — display-only, not committed to history). The card tints are the ONE deliberate exception to theme.rs's no-bg-fill rule. Focus (Ctrl-P) hides Tool+Thinking.
  - `editor.rs`, `keymap.rs`, `markdown.rs`, `theme.rs` — input/render helpers.
  - `knowledge.rs` — `/init` and `/knowledge` snapshot/diff workflow.
- `src/provider/`, `src/model.rs` — provider abstraction and OpenAI-compatible client; Azure/custom are wired, Vertex/Anthropic staged.
- `src/mcp/` — `.mcp.json` loading/merge and RMCP client.
- `src/rekey.rs` — `/task` worktree re-key git flow.
- `src/session.rs` — persistent interactive sessions: a UUID + named artifacts in a GLOBAL store (`~/.config/aj/sessions/<uuid>/`), OUTSIDE any repo, so a fresh run inherits nothing and stale plans can't bleed. `mint`/`load`/`most_recent_for` (scan-keyed by canonical worktree path, no index file). The model reads/writes artifacts via the `save_artifact`/`read_artifact` tools (gated on a session store being attached — interactive only; headless `--once` gets `None`). `--resume <uuid>` / `--continue` reopen one; bare `agentj` mints fresh. `frontier_resume` (`agent/mod.rs`) — a plain free function, injected on the first turn only — resumes from the `plan` artifact when a session is attached, else a headless run's in-tree `.aj/task/plan.md`. It is a resume convenience, not a steering nudge.
- `src/jobs.rs` — background command manager and nudge queue.
- `src/exec.rs` — process-group command runner.
- `tests/pty_input.rs` — PTY integration coverage for interactive input behavior.

## Local conventions
- Non-streaming loop is intentional; do not switch behavior casually.
- Keep TUI boundaries intact:
  - state/update logic in `tui/app/`
  - await/orchestration in `tui/mod.rs`
  - drawing in `tui/view/`
- `run_subagents` is a first-class feature here:
  - parent interception and fan-out are in `src/agent/delegate.rs` (the tool the model sees is named `run_subagents`; the Rust module/fn keep the `delegate` name).
  - subagents are **typed** (`src/agent/agent_type.rs`): each `run_subagents` task carries a `type` (scout/planner/reviewer read-only; executor = default, makes changes). The type = a role identity (`AgentType::identity`, prepended in `prompt::subagent_system_prompt`) + a scoped tool allowlist (`AgentType::allows`), enforced both in `tool_specs(…, agent_type)` (what's advertised) and `Tools::call` (dispatch). `Tools::scoped_to(type)` builds the per-subagent tool set (shares handles, drops the artifact store, fresh read-stamps).
  - depth is capped; subagents do not re-delegate (`allow_delegate=false` for a subagent).
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
- `cargo test --manifest-path agentj-rs/Cargo.toml` — passed: 197 unit tests + 5 PTY integration tests.
