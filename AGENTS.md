# AGENTS.md — agentj

## What this repo is
- Product: `core/` — Bun TypeScript terminal coding agent. The sole shipped implementation.
- Root layer: `package.json` convenience scripts for test/typecheck/eval; not a separate app.
- Eval harness: `core/eval/` — task runner and fixture-based grading for agent behavior.

## Component map
- `core/`
  - Bun TypeScript agent and only shipped product.
  - Key areas:
    - `core/agent-loop.ts` — thin `import.meta.main` entrypoint. Constructs production dependencies (prompt UI, terminal writers, transcript renderer, task-run dependencies) and delegates to `runAgentjCli`. Owns SIGINT handler lifecycle. No orchestration logic.
    - `core/lib/app/` — task orchestration. `run.ts` exports `runAgentTask`, an injectable application service that sequences sandbox → session → agent → generation → commit, emitting structured `TaskRunEvent` callbacks and returning a discriminated `TaskRunOutcome`. `createProductionTaskRunDependencies` wires real sandbox/session/agent factories. Domain modules (agent, session, sandbox) are unchanged by this extraction.
    - `core/lib/cli/` — `cmd-ts` command construction and dispatch. `index.ts` builds the CLI command with an optional positional task argument; bare invocation delegates to `PromptUi.askTask()`. The handler invokes the shared `runAgentTask` runner and maps `TaskRunOutcome` to exit codes (0 success, 1 failure, 130 aborted). `runAgentjCli` wraps `cmd-ts` `runSafely` for testable error routing.
    - `core/lib/tui/` — terminal interaction and rendering. `index.ts` defines injectable `PromptUi` (wrapping `prompts` for one-shot task collection; cancellation returns `null`), `TerminalWriters` (stdout/stderr adapters), and `TranscriptRenderer` (line-oriented ANSI renderer with semantic sections: Prompt, Session, Tool, Result, Commit, and error/abort outcomes). Tool payloads are safely truncated via `safeRenderJson`. No fullscreen state machine.
    - `core/lib/agent/` — agent assembly (`index.ts`) and subagent delegation (`delegate.ts`). Composes llm + prompt + tools into a runnable agent. Delegation creates depth-capped child agents in isolated git worktrees via `run_subagents`.
    - `core/lib/session/` — worktree lifecycle. Creates branches/worktrees from a parent ref, commits on success, preserves on failure, deletes clean branches. Child lanes never force-delete uncertain work.
    - `core/lib/scm/` — git primitives expressed as sandbox commands. Branch creation, worktree management, commit, branch deletion, safe inspection. No port of its own — git runs inside the sandbox boundary.
    - `core/lib/sandbox/` — port (`index.ts`) + adapter (`microsandbox-adapter.ts`). Command execution and file IO in an isolated environment. Swapping execution backends means writing a new sandbox adapter.
    - `core/lib/tools/` — agent tools: `bash/`, `edit/`, `search/`. Defined against the sandbox port; no vendor SDK imports.
    - `core/lib/llm/` — port (`index.ts`) + adapters (`ai-sdk-adapter.ts`, `azure-adapter.ts`). The model and its generation loop behind a vendor-free `AgentRuntime` interface.
    - `core/lib/prompt/` — pure prompt composition from config + context.
    - `core/lib/config/` — composes domain schemas; defines no shapes of its own.
    - `core/eval/` — eval runner (`run.ts`), task definitions, graders, fixtures, and adapters.
- `package.json`
  - Convenience scripts only: `agentj`, `test`, `typecheck`, `eval`, `eval:report`, `eval:selfcheck`.
- `README.md`
  - User-facing overview and run/develop commands.

## How the pieces fit together
- `core/agent-loop.ts` is the composition root: it constructs production dependencies (prompt UI, terminal writers, transcript renderer, task-run dependencies) and delegates to `runAgentjCli`. Owns SIGINT handler lifecycle. No orchestration logic.
- `core/lib/app/run.ts` exports `runAgentTask`, an injectable application service that sequences sandbox → session → agent → generation → commit, emitting structured `TaskRunEvent` callbacks and returning a discriminated `TaskRunOutcome`. `createProductionTaskRunDependencies` wires real sandbox/session/agent factories. Domain modules (agent, session, sandbox) are unchanged by this extraction.
- `core/lib/cli/index.ts` builds the `cmd-ts` command with an optional positional task argument; bare invocation delegates to `PromptUi.askTask()`. The handler invokes the shared `runAgentTask` runner and maps `TaskRunOutcome` to exit codes (0 success, 1 failure, 130 aborted). `runAgentjCli` wraps `cmd-ts` `runSafely` for testable error routing.
- `core/lib/tui/index.ts` defines injectable `PromptUi` (wrapping `prompts` for one-shot task collection; cancellation returns `null`), `TerminalWriters` (stdout/stderr adapters), and `TranscriptRenderer` (line-oriented ANSI renderer with semantic sections: Prompt, Session, Tool, Result, Commit, and error/abort outcomes). Tool payloads are safely truncated via `safeRenderJson`. No fullscreen state machine.
- `core/lib/agent/index.ts` composes the three domain modules the loop needs: `llm` (which model), `prompt` (how it behaves), and `tools` (what it can do).
- `core/lib/session/index.ts` owns branch/worktree identity. Child sessions branch from the parent's current commit and follow a data-loss-safe lifecycle: commit + preserve branch on success, delete branch + worktree on clean no-op, preserve everything on failure/abort.
- `core/lib/scm/git.ts` runs git inside the sandbox. All scm, session, and tool code follows unchanged when the sandbox adapter is swapped.
- `core/lib/sandbox/` is the only boundary to the host. Ports and domain services depend on zod and other lib modules only — never on vendor SDKs. Vendor imports live only in `*-adapter.ts` files.
- `core/eval/run.ts` copies a fixture to a temp dir, initializes git, runs setup, runs the agent, then grades with structured graders.
- Current behavior is defined by the core TypeScript code above.

## Agent conventions for this repo
- Work in the real product: `core/` is the app. There is no other implementation.
- Keep changes small and local.
- Match existing module boundaries in `core/lib/`:
  - task orchestration in `app/`
  - CLI command construction and dispatch in `cli/`
  - terminal interaction and rendering in `tui/`
  - agent assembly and delegation in `agent/`
  - worktree lifecycle in `session/`
  - git primitives in `scm/`
  - sandbox port + adapters in `sandbox/`
  - agent tools in `tools/`
  - model runtime port + adapters in `llm/`
  - prompt composition in `prompt/`
  - config schema composition in `config/`
- Ports and domain services depend on zod and other lib modules only — never on vendor SDKs. Vendor imports (`ai`, `@ai-sdk/*`, `bash-tool`) live only in `*-adapter.ts` files.
- Prompt libraries (`prompts`, `cmd-ts`) are confined to `tui/` and `cli/` respectively. Domain modules (`app/`, `agent/`, `session/`, `sandbox/`, `tools/`, `llm/`, `prompt/`, `config/`) never import prompt or CLI libraries.
- Imports are side-effect free: importing CLI, TUI, or domain code in tests never starts a sandbox, model call, or TTY interaction. `core/agent-loop.ts` is the only module that constructs production dependencies and runs the CLI.
- The TUI is line-oriented and one-run: no fullscreen state machine, no cursor-addressed rendering, no progress bars, no multi-turn chat loop. The transcript renders semantic sections (Prompt, Session, Tool, Result, Commit) with optional ANSI styling.
- Swapping the generation stack is a new `llm/<name>-adapter.ts` registered under the runtime registry — no domain code changes.
- For eval work, document and preserve objective graders; do not replace strict checks with prose.

## Child worktree data-loss rules
- **Never force-delete a child worktree that might contain uncommitted work.** The child session lifecycle enforces this:
  - **Success with changes:** commit, remove worktree, preserve branch. Branch + commit metadata returned to parent.
  - **Success with no changes (clean):** remove worktree, delete branch. Nothing to preserve.
  - **Failure, panic, or abort:** preserve worktree and branch. Return recovery metadata (path, branch, error). The parent or operator decides what to keep.
- Destructive cleanup occurs only after a proven-clean or successfully committed lane. Drop/abort never deletes uncertain work.
- Child agents cannot delegate recursively — the `run_subagents` tool is omitted from child tool sets.

## Verified commands
Ran from repo root:
```sh
bun test core
bun run typecheck
bun core/eval/run.ts --selfcheck
bun install --frozen-lockfile
```

Convenience equivalents defined in `package.json`:
```sh
bun run agentj
bun run agentj -- "task"
bun run agentj -- --help
bun run test
bun run typecheck
bun run eval
bun run eval:report
bun run eval:selfcheck
```

## Verification evidence
- `bun test core` — passed: 136 tests across 12 files.
- `bun run typecheck` — passed.
- `bun core/eval/run.ts --selfcheck` — passed: proves each grader fails unsolved and passes on the reference solution.
- `bun run agentj -- --help` — prints usage with positional task argument and version flag.
