# agentj-rs — the agentj crate (ratatui edition)

**This is agentj.** A Rust terminal coding agent with a full-screen **ratatui** UI. It began as a port
of a now-retired TypeScript implementation (the `TS` column below is that reference); the TS package was
removed in the Rust cutover, so this crate is the product.

```sh
cd agentj-rs
cargo build
cargo run -- --help
cargo run -- --once "add a --json flag and run the tests"   # headless
cargo run                                                    # full-screen ratatui chat
```

## Why it's a reimplementation, not a transliteration

The TS version leans entirely on the Vercel AI SDK (`ai` / `@ai-sdk/*`). There's no equivalent in
Rust, so the provider HTTP clients, the tool-call loop, and structured output are hand-written
(reqwest + serde). And ratatui is full-screen/immediate-mode, so the UI *replicates the behavior*
(per-step transcript with markdown-rendered replies, tool lines, spinner/status, `/task`, slash
highlight + a fuzzy completion popover, Ctrl-C) in a proper full-screen layout rather than the TS inline-scroll
model. The loop is non-streaming on purpose (Vertex mangles Gemini thought-signatures on streamed
tool replay), so the transcript updates once per model step, not per token.

The UI code lives under `src/tui/` — `app/` (state + transitions), `view/` (rendering),
`markdown.rs`, `editor.rs`, `keymap.rs`, `theme.rs` — with the event loop in `tui/mod.rs`.

## Parity status

| Area | TS (`packages/agentj`) | Rust (`agentj-rs`) |
|---|---|---|
| Full-screen TUI + per-step transcript | inline raw-ANSI | ✅ ratatui, markdown-rendered replies |
| Live subagent panel + context/token meter | — | ✅ Rust-first (`tui/view/`) |
| Slash-command highlight + fuzzy completion popover | ✅ | ✅ (`commands.rs` + `tui`, tested) |
| `/task` LRW re-key (wipe → fetch → checkout) | ✅ | ✅ (`rekey.rs`, tested) |
| Built-in tools (read/write/edit/ls/glob/grep/bash) | ✅ | ✅ (`tools/`) |
| Process-group command runner (kill the tree) | ✅ | ✅ (`exec.rs`, `process_group` + killpg) |
| Tool-call loop, non-streaming | ✅ | ✅ (`agent/`) |
| System prompt (identity/context/instructions) | ✅ | ✅ (`prompt.rs`) |
| **OpenAI-compatible provider (Azure / custom)** | ✅ | ✅ (`provider/openai.rs`) |
| Vertex (Gemini) provider | ✅ | ⏳ stage 2 |
| Anthropic provider | ✅ | ⏳ stage 2 |
| MCP tools (stdio + no-auth http) | ✅ | ✅ (`mcp/*` via `rmcp`; config tested) |
| MCP static-header / OAuth | ✅ | ⏳ staged |
| Supervised auto-continue | ✅ | ⏳ stage 2 (`finish_reason` already plumbed) |
| **Subagents** — parallel `delegate` (DAG execution) | — | ✅ Rust-first (`agent/delegate.rs`) |
| **Background jobs** — non-blocking + nudges | — | ✅ Rust-first (`jobs.rs`, tested) |
| **SPEAR instructions** (Scope/Plan/Execute/Assess/Resolve) | — | ✅ Rust-first (`prompt.rs`) |

## Run against Azure (what's wired)

```sh
AZURE_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
AZURE_API_KEY=… \
cargo run -- --provider azure --model gpt-5.4
```

App config is also loaded from `~/.config/aj/aj.json`, `{PROJECT}/.aj/aj.json`, and
`{PROJECT}/.aj/aj.local.json` with later files winning. Environment variables override file values, and
CLI flags override both. Supported file keys are `provider`, `model`, `base_url`, `company`,
`max_steps`, `max_idle_nudges`, and `job_idle_wait_s`.

Env knobs: `AGENTJ_PROVIDER`, `AGENTJ_MODEL`, `AGENTJ_BASE_URL`, `AGENTJ_API_KEY`, `AGENTJ_MAX_STEPS`,
`AGENTJ_COMPANY`, `AGENTJ_ALLOW_PRIMARY`, `AGENTJ_MAX_PARALLEL_SUBAGENTS`, `AGENTJ_MAX_IDLE_NUDGES`,
`AGENTJ_JOB_IDLE_WAIT_S`, and `AGENTJ_CONTEXT_WINDOW` (overrides the model table behind the context
meter). Runtime knobs are resolved once at startup into `config::Config`.

## Verified / not

- **Verified here:** `cargo build` warning-clean, `cargo clippy --all-targets -D warnings` clean,
  `cargo test` (unit tests across commands/model/rekey/jobs/mcp/config/agent/tui — the agent loop is
  driven by a scripted-model test seam; the TUI is rendered to a `TestBackend` and asserted; plus the
  `tests/pty_input.rs` PTY integration suite), `--help` / `--version` / preflight error paths.
- **Not verified here:** a live model turn (needs real credentials) and the interactive TUI against a
  real TTY (`enable_raw_mode` won't run under a pipe).
