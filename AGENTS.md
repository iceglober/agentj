# AGENTS.md — agentj

## What this repo is
- Product: `core/` — Bun TypeScript terminal coding agent. The sole shipped implementation.
- Root layer: `package.json` convenience scripts for test/typecheck/eval; not a separate app.
- Eval harness: `core/eval/` — task runner and fixture-based grading for agent behavior.

## Component map
- `core/`
  - Bun TypeScript agent and only shipped product.
  - Key areas:
    - `core/agent-loop.ts` — CLI entry and top-level agent loop; wires sandbox, runtime, session, and tools together.
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
- `core/agent-loop.ts` is the composition root: it picks adapters, creates a session, assembles an agent, and runs the model/tool loop.
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
  - agent assembly and delegation in `agent/`
  - worktree lifecycle in `session/`
  - git primitives in `scm/`
  - sandbox port + adapters in `sandbox/`
  - agent tools in `tools/`
  - model runtime port + adapters in `llm/`
  - prompt composition in `prompt/`
  - config schema composition in `config/`
- Ports and domain services depend on zod and other lib modules only — never on vendor SDKs. Vendor imports (`ai`, `@ai-sdk/*`, `bash-tool`) live only in `*-adapter.ts` files.
- Swapping the generation stack is a new `llm/<name>-adapter.ts` registered under the runtime registry — no domain code changes.
- For eval work, document and preserve objective graders; do not replace strict checks with prose.

## Host project mount and session worktree boundary

When AgentJ is launched from a host project directory, the sandbox adapter bind-mounts two host paths into the guest at their same canonical paths:

1. **The project root** — the Git worktree containing the host checkout (e.g., `/Users/…/my-project`).
2. **The common Git directory** — the shared object database (`.git` for a main worktree, or the separate Git dir for a linked worktree). This is mounted only when it lives outside the project root, which is the case for linked worktrees.

The session's `repoDir` is set to the project root path. The session then creates an isolated worktree from the host repository's current Git state. This means:

- **Source is the host repo, edits are in the guest worktree.** The host checkout at the mount point is the Git source — the session branches from it and creates a separate worktree under the session root. Structured tools (`edit`, `write`, `serena_replace_content`, etc.) operate inside that guest session worktree, not on the host checkout.
- **No direct host checkout edits under normal structured tools.** The host checkout is read-only source material. The agent never writes back to the host checkout through the structured tool layer.
- **Raw bash can reach the host checkout.** The `bash` tool runs inside the sandbox with full filesystem access. A raw shell command that writes to `repoDir` directly edits the host checkout. This is intentional power, not a sandbox bypass — the agent is trusted with the host repo. Structured tools are the safe default; raw bash is the escape hatch.
- **Why the common Git directory needs its own mount.** Linked worktrees store `.git` as a plain file containing a path to the common Git directory (e.g., `gitdir: /path/to/main/.git/worktrees/name`). Without bind-mounting that common Git directory into the guest, `git worktree add` inside the sandbox cannot find the shared object database and fails. The adapter detects this case via `git rev-parse --git-common-dir` and mounts the common Git dir at its canonical host path when it differs from the project root.
- **Host Git branch recovery.** Session commits create branches in the host repository's Git database. If the session succeeds, the branch and its commits are preserved in the host repo. If the session fails or is aborted, the branch and worktree are preserved for manual recovery. The host checkout itself is never auto-committed or auto-modified.
- **Non-Git launch directories fail before any model call.** The adapter runs a preflight check: `git rev-parse --show-toplevel` on the host project directory. If this fails, the sandbox is never created and the agent never boots. The caller gets a clear error message. No `git init` is ever run in a caller directory.
- **No-project mode.** When no host project directory is configured, the sandbox boots without any bind mounts. The session's `repoDir` defaults to `/repo` (a schema default, not a mount), and the session initializes a fresh repository there.

### Verification commands

```sh
bun test core/lib/sandbox
bun test core/lib/app
bun test core
bun run typecheck
bun core/eval/run.ts --selfcheck
```

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
bun run test
bun run typecheck
bun run eval
bun run eval:report
bun run eval:selfcheck
```

## Verification evidence
- `bun test core` — passed: 108 tests across 9 files.
- `bun run typecheck` — passed.
- `bun core/eval/run.ts --selfcheck` — passed: proves each grader fails unsolved and passes on the reference solution.
