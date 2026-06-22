# AGENTS.md — coder

Guidance for agents (and humans) working in this repo.

## What this is

`coder` is a self-contained coding agent. Its design principles are not preferences —
they are backed by research (see `docs/PLAN.md` § "Evidence base"). Honor them:

1. **Compute, don't infer.** Any deterministic fact becomes one structured call
   (a Capability), never a tool-and-reason chain that drags raw output into context.
2. **Context is a budget — managed for accuracy *and* cost.** Long context measurably
   degrades model accuracy; load tools/dets/docs/history by relevance, trim to a target.
3. **Succinctness is engineered, not requested.** Enforce brevity structurally (provider
   knobs + output shaping + measurement), never by "be brief" prompting alone.
4. **Measured by default.** Every operation emits OpenTelemetry spans + metrics and a
   Ledger receipt from day one.

## Constraints

- **Self-contained.** Zero runtime dependency on `glrs`. glrs is prior art only —
  reimplement small patterns clean, never import (see `docs/PLAN.md` § "glrs prior-art map").
- **Multi-provider via the Vercel AI SDK** (`ai` + provider packages). coder owns its
  agent loop on `streamText` + the tool-exec cycle; it does not delegate the loop.
- **Sandbox safety:** tools confined to the worktree (reject `..`/symlink); `bash` runs
  in the container; credentials never enter the sandbox.

## Repo conventions

- Bun workspace; TypeScript strict (`tsconfig.base.json`). ESM only.
- `bun run typecheck` / `bun run test` / `bun run lint` at the root fan out to all packages.
- Package dependency direction: `coder-core` ← `coder-server`, `coder-tui`.
  `coder-core` depends on nothing in-repo.
