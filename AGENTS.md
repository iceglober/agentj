# AGENTS.md — agentj

Guidance for agents (and humans) working in this repo.

## What this is

`agentj` is a simple, self-contained terminal coding agent — same category as Claude Code /
Opencode. One package (`packages/agentj`), no server, no worktrees, no toolchain detection. It
reads/writes files, runs commands, and calls a model in a loop until the task is done. The
guiding principle is **make it work and keep it small** — this is a deliberate rewrite that
peeled back an earlier, more elaborate architecture (those notes live in `docs/`).

## How it fits together

- `src/index.ts` — CLI entry: parses flags, runs `mcp` subcommands, else chat or `--once`.
- `src/chat.ts` — the interactive loop: read a line → run a turn → repeat. Holds the message history.
- `src/agent.ts` — the model loop. Wraps the Vercel AI SDK `ToolLoopAgent`; instruments each tool
  call to emit `tool.start`/`tool.end` events. Runs in windows of `AGENTJ_MAX_STEPS`; when a window is
  exhausted mid-work (`finishReason === "tool-calls"`) a cheap supervisor (`superviseContinue`, one
  `generateObject` call over a tail) decides whether to auto-continue, stop, or hit the ceiling — it
  never stops silently. Natural completion (model stops calling tools) needs no supervisor.
- `src/tools.ts` — the built-in tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`,
  `grep`, `bash`. They return strings and never throw; output is truncated inside `execute`.
- `src/exec.ts` — the command runner. Spawns in a detached process group so Ctrl-C/timeout kills the
  whole tree, not just the shell.
- `src/model.ts` — provider resolution (Vertex / Anthropic / Azure / custom OpenAI-compatible) + preflight credential check.
- `src/render.ts` / `src/input.ts` — raw-ANSI transcript + heartbeat line, and a raw-mode line reader.
- `src/mcp/*` — `.mcp.json` config, client (connect once at startup), OAuth, token store, AI-SDK adapter.

## Conventions

- **Self-contained.** No runtime dependency on `glrs`. Reimplement small patterns clean, never import.
- **Multi-provider via the Vercel AI SDK** (`ai` + provider packages). agentj owns its loop via
  `ToolLoopAgent`; it does not delegate the loop.
- **Non-streaming on purpose.** Vertex mangles Gemini thought-signatures when streaming a tool replay,
  so the loop uses `agent.generate(...)`, not streaming.
- **Permissions are auto.** Every tool call proceeds — the user owns git as the safety net. No
  allow/ask/deny gate.
- **Path confinement.** File tools resolve through `safeResolve`, which rejects `..` and symlink
  escapes so a tool can't touch anything outside the repo root.
- **Tools never throw.** A failed tool returns an error string the model can read and react to.

## Repo conventions

- Bun workspace; TypeScript strict (`tsconfig.base.json`). ESM only; relative imports use explicit
  `.ts` extensions (`allowImportingTsExtensions`). Bun runs the TS directly — no build step.
- `bun run typecheck` (`tsc --noEmit`) and `bun run test` (`bun test`) at the root fan out to the package.
- Match the surrounding style. Keep additions small and justified — the whole point of this rewrite is
  that the agent is simple enough to reason about in one sitting.
