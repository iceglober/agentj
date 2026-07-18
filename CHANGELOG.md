# @glrs-dev/aj

## 0.1.0-next.13

### Minor Changes

- f8cd7a7: Cost-optimization change set: provider-agnostic model tier ladder (`llm.tiers`/`llm.modes`, plan rides the frontier tier, subagents route via `tools.subagents.tier`; an explicit runtime model selection overrides mode routing); configurable tool-output caps with spill-to-file recovery and readFile `offset`/`limit`; config-driven OTLP metrics export (`metrics.*`); live cache-read ratio next to ctx in the status line; and a context soft limit (`agent.context.softLimit`) that warns the interactive session and stops fresh-context children at the same ceiling.

## 0.1.0-next.12

### Patch Changes

- 0180444: Long completion and guided-input lists now scroll with the selection instead of truncating at 7 rows. All list surfaces (slash completions, `/config set` paths, guided choices) render through one windowed-list primitive with `… ↑N/↓N more` overflow markers, so every item is reachable with the arrow keys.

## 0.1.0-next.11

### Minor Changes

- fef56f5: Add guided `/model` configuration for primary agents, subagents, and background jobs, including provider/model overrides and live updates for new work. Improve interactive chat handling for multiline input, queued-message restoration, and shutdown resume instructions.

## 0.1.0-next.10

### Minor Changes

- 7391b4e: Subagent and background-job tool calls now answer to the session permission gate: build-mode `run_subagents` children and `&`-job delegates previously ran bash on the host with no prompts (worktree isolation only confines their edits). Their asks queue into the same modal, labeled with the requester (`Permission bash — subagent t2`, `job j1`), and session-wide "always" grants apply across parent and children. Non-interactive `run` applies its allow-all/deny policy to children too.

## 0.1.0-next.9

### Patch Changes

- 9935080: Permission prompts show the actual command inside the modal (wrapped, indented) instead of pointing at a transcript line that may have scrolled away; only requests longer than six wrapped lines also print a full transcript copy, with the modal noting how many lines it omitted.

## 0.1.0-next.8

### Minor Changes

- c82c385: The chat status becomes a section below the editor: an identity line (session · provider/model · mode) with right-aligned cumulative token counters and a session clock, the session's root path on its own line with the busy indicator at its right end, and one row per running background job. The startup header line is gone; narrow terminals drop counter labels before truncating, and long paths middle-ellipsize.

## 0.1.0-next.7

### Minor Changes

- 761927a: Plan mode exposes MCP tools gated by the server's `readOnlyHint` annotation, and tool/resource mode filters default to `["*"]` — read-only MCP tools (e.g. Linear's `list_*`/`get_*`) now work in plan mode out of the box, while write tools stay build-only.

## 0.1.0-next.6

### Minor Changes

- ee04a06: `/mcp` management commands in chat: status, guided `add`, `auth` (Authorization header), `reload`, `remove`, and `set`, with masked modal input and slash completion.
- 8ccc51e: `/mcp auth` runs a real OAuth 2.1 browser flow for HTTP MCP servers (discovery, dynamic client registration, PKCE, loopback callback), storing tokens in the OS keyring with automatic refresh on reconnect; the pasted-header path remains as a fallback.

## 0.1.0-next.5

### Patch Changes

- b4a5dbb: `--version` and `--help` output ends with a newline, so the shell prompt no longer glues to it.

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
