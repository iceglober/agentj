# @glrs-dev/aj

## 0.1.0-next.4

### Patch Changes

- f61bc0f: `aj --version` reports the real package version instead of a hardcoded `0.0.0`.

## 0.1.0-next.3

### Minor Changes

- 4a601f7: Chat-first rewrite: `agentj` now opens a persistent chat session (plan mode, Tab to build) instead of the one-shot plan→approve→build pipeline. New: `agentj run "task"` (non-interactive, `--plan`, `--allow-all`), `--continue`/`--resume` over JSONL session logs, a host-first permission system (`permissions.*` config: edit policy + bash prefix allow/deny lists), background jobs (`& task`, `/jobs`), `/build` to implement the plan and discussion so far, `/undo`//`/redo` via git snapshot refs, `@file` attachments, and one unified `run_subagents` task-DAG tool (read-only researchers in plan mode, worktree children with batch integration in build mode). Removed: the `sandbox` subcommand as a user surface (Microsandbox remains inside the eval harness), manifest-based `--resume`, the approval-phrase gate, and the `agentj:secrets` shim (use `agentj config set --secret`). Prompt content for build agents is byte-identical (hash-pinned); the eval harness is unchanged.
- dda639d: Add MCP tools and resources over stdio and Streamable HTTP, with catalog discovery, direct tool schemas, mode filtering, permissions, and session lifecycle management.

## 0.1.0-next.2

### Patch Changes

- 3acc069: Fix npm-installed `agentj` and `aj` launchers resolving the package entrypoint through npm's `.bin` symlink.

## 0.1.0-next.1

### Patch Changes

- 2a9f20c: Add Biome formatting and linting to local scripts and CI.

## 0.1.0-next.0

### Minor Changes

- Publish the first AgentJ prerelease under the `@glrs-dev/aj` npm scope.
