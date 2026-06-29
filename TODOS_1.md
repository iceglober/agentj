# coder — TODOS · Done

Shipped, grouped by capability (aligned with [docs/PLAN_1.md](./docs/PLAN_1.md)). Remaining work
is in [TODOS_2.md](./TODOS_2.md). ✅ = complete.

---

## Agent core

- ✅ **Non-streaming loop**: `ToolLoopAgent.generate()` rendered per-step; the Vertex streaming path mangled Gemini-3 thought-signatures on tool replay.
- ✅ **Guaranteed conclusion**: hitting the step ceiling (40, `CODER_MAX_STEPS`) forces a final no-tools synthesis — always an answer.
- ✅ **Subagent orchestration**: triage (investigate/direct) → isolated read-only investigator → implementer; keeps only the verdict + report, never transcripts. **Direct is a subagent too** — it runs isolated and only its compact result threads to history (the tool transcript never persists); every path returns `prior compact history + this turn's compact pair` (fixed a gap where direct kept the full transcript and investigate dropped prior turns). One terminal `turn.idle` per user turn; `phase.start/end` bracket each phase for the TUI. A clarifying-question investigation **stops at the diagnosis** (no implementer over a question — `endsByAsking`); the question is surfaced as the answer.
- ✅ **Subagent continuity**: subagents get the compact prior-turn verdicts (working memory); triage reads recent session so follow-ups route direct.
- ✅ **Cut-off = resumable working memory**: a step-limit conclusion writes a progress note (changed/established/tried/hypothesis/next); `cutOff` makes the orchestrator continue, not blind-apply.
- ✅ **Role-as-toolset keystone**: tools declare `effect` (read|verify|write); a role is a filtered view (`toolsForRole`); investigator = read+verify; policy effect-aware (verify allowed in plan).
- ✅ **Permission policy**: per-call `decide → allow/ask/deny`, posture presets + per-tool overrides, effect-aware; interactive `--mode ask` in-process.
- ✅ **Models**: multi-provider (Vertex/Gemini + Anthropic), per-provider tiers, preflight; `/models` + `/model <id>` live-switch persisted; dynamic models.dev pricing (cached, >200k tier) + prompt-cache-aware (`% cached`); on AI SDK v7.
- ✅ **SIGINT cancellation**: Ctrl-C → AbortSignal through the tui + runner.
- ✅ **Single loop**: deleted the unwired `loop.ts`; `runner.ts` is the one path, mock-model injectable.

## Behavior steers (workflow → prompt/triage; evidence, not exhortation)

- ✅ **Ambiguity**: a vague task routes to *direct*; charter + investigator state a bounded interpretation + smallest change, or ask — no guess-and-sweep.
- ✅ **Structured clarification**: coder NEVER asks in prose — it calls the `ask_user` tool with multiple-choice questions (2–4 options each, a recommended default), emitted as a `questions.required` event; the orchestrator stops (no implementer over a question) and it's never sign-off-worthy. The TUI renders them in a full-screen **modal** with an ASCII alien-scholar hero whose **eyes blink** every ~3s (↑/↓ · a–d · Enter · Esc), and the picks submit as the next turn.
- ✅ **Delegation reasoning**: for an ambiguous task / missing input, coder leads with its understanding (what it grasped + searched + couldn't find), then asks the **delegation fork** — (a) have-it-share-next · (b) show-me-options · (c) **you-decide (default)** — biasing to autonomy. For (c) it decides from context or asks ONE narrow follow-up, then commits; never chains rounds. (charter + investigator prompts.)
- ✅ **Choice Display abstraction**: options carry a typed `preview` — `swatches` (hex → colored blocks), `code`/pseudocode, `tree` (file layout), `chart` (scaled ASCII bars), `text`. Protocol (`ChoicePreview`) + `ask_user` schema + a TUI `ChoicePreviewView` (truecolor swatches via chalk hex; blocks truncated). So "show me options" shows the actual colors, not just labels.
- ✅ **Failing-checks**: establish *which* checks fail first (declared `checks`, else local + a caveat), fix only those, iterate via single-file test runs.
- ✅ **Whole-workspace**: `script`'s result *notes* when a bare `test` ran every package — evidence on the tool, not the charter.
- ✅ **Timeout guard + wall-clock**: `RunSignals` counts timeouts per task; the tool refuses a 3rd spawn after 2 timeouts (returns evidence). `Effort` gained `timeouts` + `toolMs`, both on the receipt line.
- ✅ **Thrash signal**: exact-repeat calls counted into `effort.repeatedCalls` and surfaced; measured, not nudged.
- ✅ **Legible failures**: `test_summary` keeps the failure block (assertion + `file:line`), not just counts.

## Project intelligence

- ✅ **Polyglot toolchain detection**: `detectProjectFacts` (js/python, pluggable `Detector`); deterministic, cached, gitignore-respecting; persisted `{computed, overrides}`, overrides win + survive.
- ✅ **script tool**: resolves + runs the exact command per path — npm-vs-pnpm error class gone; facts slice is a one-line pointer (commands live in the tool).
- ✅ **Workspace-scoped commands**: a path inside a package scopes to it (`pnpm --filter …`); install stays repo-wide.
- ✅ **Single-file test variant**: a test FILE runs just that file via the package's cached runner, bypassing a turbo/wrapper root; declared `test:file` template overrides.
- ✅ **Declared + parameterized commands**: stack-neutral remote CI as a declared `commands` entry; named placeholders (`{pr}`) filled from a model `args` map, **shell-quoted** (injection-safe), `task` validated.
- ✅ **Project pattern memory**: coder elicits + records durable patterns (design/architecture/tooling/infra/convention) via a `remember` tool into a `patterns` section of `.coder/facts.json` (sibling of `overrides` — never auto-regenerated). A pattern holds a literal `value` OR a **`ref` to live code** (preferred — stays current when code changes, read on demand, keeps the codebase DRY). `renderPatterns` injects a compact pointer index each turn (contents never inlined). Auto-saved but **visible** (`🧠 remembered` line), auto-allowed except **denied in plan mode**. ⬜ relevance-gate the index at scale.

## Execution safety

- ✅ **Sandbox (P0)**: `CommandRunner` seam; `DockerSandbox` (bind-mount, lifecycle, in-container timeout, hardening, mount preflight); **creds never enter the sandbox**.
- ✅ **Routing by source**: untrusted repo code → sandbox, trusted declared commands (`gh`) → host, so isolation doesn't break the forge workflow.
- ✅ **OOM guard**: `script`/`bash` share a concurrency gate (default 1, `CODER_MAX_PARALLEL_COMMANDS`); reads stay parallel; the gate sits in the execute wrapper so the UI shows real serial execution.
- ✅ **Process-group kill**: commands spawn detached; abort/timeout kills the whole tree (bash→turbo→vitest→workers) — Ctrl-C is instant. Path confinement rejects `..`/symlink.
- ✅ **Change accountability**: the runner always appends a computed `📝 changed N files: …` footer (from the edit tools); carried into `changedFiles` + the report; charter requires listing changes.

## Measurement

- ✅ **Ledger + receipts**: append-only JSONL; `effort` (computed) + `checks` (gate) + `verdict` (borrowed); `event-log` backing.
- ✅ **Sign-off**: `/y`·`/n`·`/skip` capture the verdict to `verdicts.jsonl`, folded latest-wins; Ctrl-C on an unsigned result → `abandoned`. Gated on `signoffWorthy` — only a real resolution (changed files, or real work that didn't end in a clarifying question) prompts; a greeting / "what kind?" doesn't.
- ✅ **Charter verdict standard**: lead-with-answer, evidence as `file:line`, tag checked/reasoned/guess, list changes.
- ✅ **/stats**: verdict mix + accepted-rate + avg effort + time-in-tools + timeouts.

## Context

- ✅ **History compaction**: summarizes older turns past 16k tokens, keeps recent verbatim, safe-degrades.

## Deterministic operations & dispatch

- ✅ **OperationRegistry**: tool/filter plumbing (`operationToolSet`, `RunSignals`).
- ✅ **Built-ins**: `git_state` + `find_def` (tools) + `test_summary` (filter), wired into the loop.
- ✅ **Zero-token dispatch**: explicit slash commands (`/git-state`, `/read`), no model/creds/sandbox, confidence-gated; free-text NL guessing removed.

## Interface

- ✅ **In-process default**: `coder` chats in-process; `--once`/`--serve`/`--connect`.
- ✅ **Full-screen Ink TUI with tabs**: captive alt-screen; tabs = concurrent sessions (async turns); **per-tab live CPU/RSS** from each session's process group; word-wrap + scroll (Ctrl-U/D); single-key `y`/`n` sign-off; per-session `/sandbox`; input history. `--classic` keeps the line client.
- ✅ **Per-session resource plumbing**: `onStart(pgid)` → `onCommand` → `sampleByPgid` (one `ps`, by group). Sampled every 250ms with a ~1.25s **peak-hold** so short commands' load actually shows — at 1s with instant zero-on-finish, a sub-second command's reading never appeared on screen.
- ✅ **Transcript tree**: the engine emits `phase.start`/`phase.end` around each phase; the TUI renders a subagent run as a GROUP whose tools stream live, then **collapse — hiding the tool noise but ALWAYS keeping the verdict/question visible** (a clarifying question can't be buried). Arrow keys navigate nodes; Enter expands/collapses a group; verdicts get inline `**bold**` styling. Renders ≤ rows-1 lines (headroom — filling the full height scrolls the terminal and corrupts Ink's redraw); `wrapLine` splits on `\n` first so every transcript row is exactly one physical line (markdown messages were breaking the height accounting → garbled overlap). (Markdown depth + multiline input are roadmap.)
- ✅ **Context meter**: status line shows `ctx prime Nk · sub Nk` — `prime` = estimated tokens of the persistent main-agent context (the budget that compounds), `sub` = cumulative ephemeral subagent tokens this session (the cost of isolation, which never persists). Engine returns `usage:{prime,subagent}` per turn (prime = est. of the compact history; subagent = summed sub-run `totalTokens`). ⬜ swap the ~4-char/token estimate for a real per-slice `ContextComposition`.
- ✅ **Live progress / heartbeat**: one bottom line showing the running call with args + clock, or `thinking`; cursor hidden while animating.
- ✅ **Server / SSE**: protocol types; runner event stream; `server.ts` routes (session/SSE/message/interrupt, bearer auth); permission round-trip.
- ✅ **Raw-mode input + conversation memory**: stdin owned (no echo), TTY-guarded; history threaded across turns.

## Output control

- ✅ **OUTPUT_CONTRACT** wired into the system prompt; `verbosityRatio` + spike threshold defined.

## Docs

- ✅ **coder-docs**: dependency-free Bun-served concept site; **Build status** reads the TODOS live.

## Cross-cutting

- ✅ **Converged tool paths**: deleted `loop.ts` + dead `Tool`/`CORE_TOOLS`; `agent/tools.ts` is the single definition.
