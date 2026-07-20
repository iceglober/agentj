# AGENTS.md — agentj

## What this repo is
- Product: `core/` — Bun TypeScript terminal coding agent (persistent chat with plan/build modes). The sole shipped implementation.
- Root layer: `package.json` convenience scripts for test/typecheck/eval; not a separate app.
- Eval harness: `core/eval/` — task runner and fixture-based grading for agent behavior.

## Component map
- `core/agent-loop.ts` — the sole production composition root. `composeChat` wires config, secrets, metrics, the host execution environment, mode-specific agents, delegation, permissions, jobs, and the chat log/undo; `runAgentjChat` (interactive) and `runAgentjOnce` (`agentj run`) are the two entrypoints. Owns SIGINT lifecycle. Wires but never orchestrates.
- `core/lib/chat/` — the interaction core, pure logic with no TTY. `session.ts`: one foreground turn at a time over an opaque message continuation, Tab-able mode with pending semantics, message queueing, abort. `jobs.ts`: user-initiated (`&`) background jobs with completion notices prepended to the next turn. `commands.ts`: input routing (slash//&/message), bounded `@file` expansion, keyed command registry including `/build` mode handoff. `events.ts`: the ChatEvent union the TUI renders.
- `core/lib/cli/` — `cmd-ts` dispatch: bare invocation → chat, `run` → one-shot, `--continue`/`--resume`, and exact `config`/`eval` routes through injected handlers.
- `core/lib/config-cli.ts` — per-key config mapping over the zod schema; `--secret` paths use the keychain; masked input via `createMaskedSecretPrompt`.
- `core/lib/tui/` — terminal surface. `chat-screen.ts`: persistent raw mode with a repainted live region (progress block → editor rows → status line), transcript printed above, single-key permission asks, Tab/Esc/Ctrl+C routing. `editor.ts` + `key-decoder.ts`: grapheme-aware multiline editor model and escape-sequence decoding (CSI-u, bracketed paste, bare-ESC flush). `terminal-editor.ts`: pure layout (wrapping, emoji widths). `progress.ts`: subagent DAG lines.
- `core/lib/agent/` — agent assembly. `index.ts` composes llm + prompt + tools; toolsets follow `mode` ("plan" = read/search + observation-only bash (+ research subagents), "build" = bash/search/edit (+ worktree delegation)) crossed with `role` (primary/delegate). `permissions.ts`: ask/allow/deny policy + `withPermissions` tool wrapper (mutating tools only, opt-in). `subagents.ts`: the unified `run_subagents` task-DAG tool over `scheduler.ts` (bounded dependency scheduler); capability injected per mode. `agent.tools.subagents.model` tier-routes children.
- `core/lib/session/` — `index.ts`: child git-worktree lifecycle (`createChildSession`/finalize — commit, clean-delete, or preserve; never force-deletes uncertain work). `log.ts`: append-only JSONL chat persistence (last state wins, torn tails skipped). `undo.ts`: snapshot/restore refs (`refs/agentj/undo/*`) via temp-index commits and verified binary patches; never touches HEAD/index/branch.
- `core/lib/workspace/` — host execution (`host-adapter.ts` runs in the caller's checkout), `project-source.ts` (launch dir → canonical worktree root), and `git-integration.ts` (delegation snapshot/integrate engine; its `refs/agentj/sessions/*` refs are load-bearing).
- `core/lib/scm/` — git primitives expressed as sandbox commands.
- `core/lib/sandbox/` — port + Microsandbox/local adapters, used only by the eval harness now.
- `core/lib/tools/` — agent tools: `bash/`, `edit/` (exact|batch|hash modes), `read/`, `search/`. Defined against the sandbox port; no vendor SDK imports.
- `core/lib/llm/` — port + adapters (`ai-sdk-adapter.ts`, `azure-adapter.ts`). `GenerateRequest.messages`/`RunResult.messages` carry the chat continuation as an opaque token only the adapter understands. Token usage preserves Azure prompt-cache detail; tool names sorted for provider caching.
- `core/lib/prompt/` — pure prompt composition: per-model profiles, `mode` (plan/build) × `role` (primary/delegate) template flags, promptVersion hashing (pinned by test against accidental content drift).
- `core/lib/config/` — composes domain schemas; config layers are project-local `.aj/config.local.json` and `.aj/config.json`, canonical global `~/.config/aj/config.json`, then legacy `~/.config/agentj/config.json` fallback.
- `core/lib/skills/` — Agent Skills (agentskills.io format): discovery over `.aj/skills/` (project) and `~/.config/agentj/skills/` (global), spec-compliant SKILL.md frontmatter validation, `/name` invocation rendering, and the progressive-disclosure prompt section appended to the rules.
- `core/lib/secrets/` — `SecretStore` port + keychain adapter; env → keychain precedence; no plaintext fallback; values never printed.
- `core/lib/metrics/` — content-free OTel sink, `AGENTJ_OTEL_METRICS=1` gated.
- `core/eval/` — eval runner (`run.ts`), tasks, graders, fixtures, adapters. Must keep working at every commit.

## How the pieces fit together
- `core/agent-loop.ts` is the only composition root; domain modules never construct production dependencies.
- The chat session emits `ChatEvent`s; the screen renders them and decides nothing. Pure logic (chat/, prompt/, scheduler, editor model) is separated from IO (chat-screen, adapters).
- Mode is capability: plan-mode agents lack edit tools; their bash is observation-scoped by prompt and gated by the same permission policy as build. No approval phrase gates the transition; Tab toggles modes and `/build` switches modes plus starts implementation.
- Permission gating wraps tool execute at one place (`withPermissions`), consulted config-first, with an injected gate function for asks. Eval and sandboxed runs pass no gate and are unchanged.
- Subagents (both modes) and background build jobs share the same machinery: snapshot → child worktree → finalize → integrate, all through `scheduler.ts` and `git-integration.ts`.
- Ports and domain services depend on zod and other lib modules only; vendor imports live only in `*-adapter.ts` files (see `core/lib/README.md`).

## Conventions
- `createX(...)` closure factories, no classes/managers/services.
- Each domain owns its zod schema; `config/index.ts` only composes them.
- Registries keyed by config values (`editModes`, `chatCommands`, `checkGraders`).
- Every module has a colocated `.test.ts`; `bun test core`, `tsc --noEmit`, and `bun run check` must stay green, and `core/eval` must keep working (`--dry-run`, `--selfcheck`) at every commit.
- Repo workflows live as Agent Skills in `.aj/skills/` (e.g. `/ship` for the changeset → PR → merge flow); prefer extending a skill over documenting a workflow only here.
