# Plan & build modes

Glorious has exactly two modes, and the boundary between them is the whole safety model. You always know which one you're in, and switching is an explicit gesture — there is no magic approval phrase.

## Plan mode (read-only)

You start here. The agent's tools are read-only: it can read files, search the repo, browse the web, and fan out research [subagents](/subagents) — but it **cannot edit anything, run mutating commands, or write to disk**. Use it to investigate an unfamiliar codebase, scope work, and agree on an approach at zero risk.

## Build mode (full tools)

Build mode unlocks edits, bash, and the full tool set — each still gated by [permissions](/permissions). Switch with:

- **Tab** — toggle plan ⇄ build when no completion is showing. Applies at the next turn if one is already running.
- **`/build`** — switch to build *and* immediately implement the plan and discussion so far.

Both are deliberate approval gestures.

## Why two modes

Read-before-write, made structural. Point the agent at code you don't know, review the plan it produces, and only then hand it the tools to act. The mode is **authoritative on every turn** — an older plan-mode refusal never leaks forward to make a build-mode agent think editing is unavailable.

## A model per mode

Plan and build can run on different rungs of your model [ladder](/config). By default plan runs on the frontier tier (best reasoning for scoping) and build on the next tier down. Configure with `agent.llm.modes.plan` and `agent.llm.modes.build`.
