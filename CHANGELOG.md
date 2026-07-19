# @glrs-dev/aj

## 0.1.0-next.30

### Minor Changes

- 5a76333: You can now press Ctrl+V in the prompt editor to insert copied local files as editable `@file` references. Paths with spaces are quoted automatically, so copying a file such as `notes/release plan.md` attaches it when you submit the prompt.

### Patch Changes

- 67e85b7: Fixes a blank gap that appeared when a tall live region shrank right before a transcript line was written — most visibly, submitting a slash command left a band of empty rows (the height of the dismissed completion menu) between the last reply and the command's output. The transcript writer no longer scrolls by the previous paint's height; it lands each line on the bottom row and lets the next repaint reserve exactly the current live region, so the padding can't go stale.

## 0.1.0-next.29

### Patch Changes

- 0911e44: The blank gap between the transcript and the editor no longer grows with the size of what was printed. The bottom-pinned live region padded each transcript write with newlines proportional to the block's own height, so a long reply or a tall progress block left a correspondingly tall band of empty rows above the editor. Writes now land tight against the pinned live region — placed exactly above it when they fit, and scrolled by a fixed amount (the live region's height) when they overflow — regardless of how many lines they contain.
- 7d5a23a: A turn that ends without producing anything no longer looks like a freeze. When the model returns no text and ran no tools, the transcript now says so instead of silently returning to the prompt. Turn errors render in red, and a provider content-filter rejection — which can fire intermittently on the same conversation — gets an explicit hint to retry or start a fresh session rather than resuming the one that keeps tripping the filter.

## 0.1.0-next.28

### Minor Changes

- f336b4b: The base prompt now carries a writing-style section — Orwell's six rules adapted for agent prose (no stock metaphors, short words, cut every needless word, active voice, plain language over jargon, and break any rule sooner than write something unclear). It rides with the communication rules in user-facing roles; subagent-contract roles, which return structured data instead of prose, and the compact low-effort templates are unchanged.

### Patch Changes

- 5b250f1: No more dead space between the transcript and the editor. After a tall progress block (parallel tools, subagent fan-outs) collapsed, the bottom-pinned live region left a permanent blank band under the transcript — the reservation only ever grew, and every transcript line was re-padded to the high-water mark. Transcript writes now land at the top of the vacated band and reclaim it, scrolling only enough to keep the rows the live region actually paints.
- 35de54c: Two resilience fixes for failed model requests. A request that dies on a transient error — our 30-minute deadline firing or the connection dropping — is now retried up to twice (10-minute deadline on retries, short backoff, caller aborts always win and are never retried); the retry re-sends exactly one HTTP request, never re-running tools. And when a turn still fails, the next turn now carries a notice with the error and the original request text, so "try again" actually retries instead of the model asking what you meant.

## 0.1.0-next.27

### Minor Changes

- 49225a6: Auto smart compact: set `agent.context.onLimit: "compact"` and when a foreground request's context crosses `agent.context.softLimit`, the session summarizes its history into a fresh continuation (via the subagent-tier model) at the end of the turn instead of only warning — the compacted state persists to the session log, so `--resume` picks it up for free. The default `"warn"` path now re-arms instead of firing once: after the first warning, it warns again each time context grows another tenth of the soft limit.
- 3d39bce: MCP capabilities can now reach subagents and background build jobs, per-server and opt-in. HTTP servers may declare `inherit: "shared"` — children get a read-only view of the primary connection's catalog (they call tools but can never reload, close, or refresh it) — and stdio servers may declare `inherit: "isolated"` — each child gets its own server process rooted at its worktree, closed deterministically when the child finishes, with cleanup on partial startup. The default stays primary-only, and children's MCP calls ride the existing `permissions.mcp` policy with asks labeled by the requesting subagent or job.
- 2a4f4d8: MCP server-provided prompt templates are now supported. Prompts are discovered with pagination at connect time (and lazily refreshed on prompt-list-change notifications), listed by `/mcp`, and invoked as namespaced slash commands like `/mcp:github:review-pr` with fuzzy completion — built-in commands always win. Arguments are collected interactively with required-field validation; the returned prompt messages (including embedded text resources) are bounded, labeled as untrusted external content, and submitted through the normal chat path, so the opaque model continuation and resumed sessions are unaffected.
- 10c2fcc: Keep Agentj’s editor, status, and other live terminal controls pinned to the bottom of the terminal while transcript output scrolls above them. For example, recalling a long multiline history entry now scrolls inside a bounded editor viewport instead of pushing the status line off-screen.
- 62b5642: Plan-mode agents — the interactive plan chat, plan background jobs, and research subagents — now carry an observation-only `bash` tool, gated by the same `permissions.bash` policy as build mode (asks are labeled with the requesting job or subagent). Previously a plan job like "wait for checks on PR 62" failed immediately because plan agents had no way to run commands at all; now it can run `gh pr checks`, inspect git state, or run tests, while file edits remain build-only.
- 5d3e44d: Terminal-native cost reporting replaces the briefly-committed Grafana dashboard (which assumed an OTLP→Prometheus pipeline most installs don't run). Each foreground turn now persists a usage record to the session log — provider/model, input tokens with cache-read/cache-write splits, output tokens, and a count of requests past Azure's 272k long-context tier — and the new `/cost` command prices the session (including resumed history) per model from the `eval.prices` $/Mtok map, showing `$ n/a` for unpriced models. Runtime metrics stay USD-free; the long-context OTel counter from the dashboard iteration is removed along with the dashboard.
- 41b87f8: Model-picking config is now tier-first everywhere: `eval.judge.tier` routes the eval judge through the `llm.tiers` ladder (default: the frontier rung, falling back to the agent model when no ladder is configured — previously a hardcoded `gpt-5.6-sol`), and both `eval.judge.model` and `agent.tools.subagents.model` are deprecated escape hatches that still win over their tiers for back-compat. A provider or ladder swap no longer touches routing config.

### Patch Changes

- bc586d9: Long model requests no longer die at five minutes. Bun's fetch imposes a hardcoded 300-second timeout when no signal is supplied, so a long reasoning request could kill a whole turn with "The operation timed out" (observed killing a one-shot `agentj run` mid-task). Azure model requests now always carry an explicit 30-minute deadline signal, composed with the turn's own abort signal so interrupts still win.
- cbaca25: Polish the interactive TUI with semantic terminal styling, clearer activity and status hierarchy, safe monochrome output, and `<Y>`, `<A>`, and `<N>` permission choices.

## 0.1.0-next.26

### Patch Changes

- 5b57b59: Auto-update now revalidates its check cache in the background. A launch inside the 24-hour check window still starts instantly off the cached answer, but the registry is re-queried behind the scenes and the cache rewritten — so a release published minutes after your last launch is picked up on the next one instead of up to a day later. Especially noticeable on the `next` channel, where publish-then-immediately-use is the normal rhythm.
- c3d6e3c: Show a compact running-job count beneath the editor, suppress misleading detached-job startup timing, and make `/jobs` show completed job results and recent activity.

## 0.1.0-next.25

### Minor Changes

- 12a18ef: Agent Skills (the agentskills.io format) are now discovered from `.aj/skills/<name>/SKILL.md` in the project and `~/.config/agentj/skills/<name>/SKILL.md` globally (project wins name collisions). Each skill's name and description are injected into the system prompt so the model can activate one by reading its SKILL.md when a task matches (progressive disclosure), and every skill is also invocable directly as a `/name` slash command — `/<name> <args>` starts a turn with the skill body as the prompt, substituting `$ARGUMENTS` when the body uses it. agentj-specific behavior rides the spec's `metadata` map: `agentj-mode: build` switches mode on invocation, `agentj-model-invocation: disabled` keeps a skill out of the prompt listing. Malformed skills surface as startup notices without blocking the session.

## 0.1.0-next.24

### Patch Changes

- 58a7a31: Make explicit updates refresh the registry, preserve terminal input when restarting after automatic updates, and restore one blank transcript row while reserving editor spacing for live activity.

## 0.1.0-next.23

### Minor Changes

- 34c4b02: Background jobs gain renewable soft timeouts and live inspection. `run_job` accepts `softTimeoutMinutes`: if the job is still running at the deadline, the agent is pinged through the normal turn queue (hidden while queued, visible once its turn runs) while the job keeps running. A new `check_job` tool shows a job's status, elapsed time, recent tool calls, and result, and lets the agent renew the soft timeout for a healthy-but-slow job or abort a stuck one. In practice: the agent estimates a test run at 5–8 minutes, sets an 8-minute soft timeout, and on ping either finds the finished result or checks the job and extends the deadline.

## 0.1.0-next.22

### Minor Changes

- 43aa8c3: The primary agent can now start background jobs itself with a `run_job` tool — the same detached runner behind `&`-prefixed input. Asked to "wait for CI and then fix failures" (or any task blocked on something external), it detaches the wait into a job instead of sleep-polling in the foreground turn; the job's outcome reports into the transcript and the next turn as before. Plan agents may only start read-only plan jobs, and one-shot `agentj run` sessions report jobs as unavailable rather than orphaning detached work.

## 0.1.0-next.21

### Patch Changes

- f13c8de: Show finished subagent result messages in progress output, reserve transcript spacing above the editor, and only show thinking while the model is generating.

## 0.1.0-next.20

### Patch Changes

- fd09f98: Esc now actually kills a running bash tool call. The turn's abort signal is threaded through the execution-environment port and across the vendor bash-tool boundary, and the host adapter kills the command's whole process group (SIGTERM, then SIGKILL) — previously the abort only cancelled the model request while the command ran to completion (up to the 10-minute timeout). Timeouts also kill the full process group now, so a compound command's child can no longer hold the tool call open after its parent bash is killed.
- 9086b78: Windowed lists (slash completions, guided choices) replace the separate `… ↑ N more`/`… ↓ N more` marker rows with one always-present footer row (`… ↑ 3 · ↓ 12 more`), so the menu no longer changes height and jumps as markers appear and disappear while scrolling.

## 0.1.0-next.19

### Patch Changes

- 414fe73: Status line: the `cached` stat now accumulates cache-read tokens across the session and shows their share of cumulative input (`in`), instead of the latest request's share of its own input — it measures how caching is working across the whole session.

## 0.1.0-next.18

### Patch Changes

- b08f1b1: Status line: replace the `(NN%⚡)` cache marker on the ctx counter with a `cached {tokens}({share}%)` stat next to the input counter — the latest request's provider-cache read tokens and their share of that request's input.

## 0.1.0-next.17

### Patch Changes

- 4bb7fbd: Add `agentj update`, `/update`, and safe automatic updates for installed CLIs.

## 0.1.0-next.16

### Patch Changes

- 84180d9: Fix MCP OAuth background token refresh: the SDK read the token-only provider's missing redirect URL as a non-interactive grant and skipped the refresh path, so expired tokens forced a manual re-auth. Also classify the SDK's numeric 401/403 error codes (whose messages omit the status) so a never-authorized HTTP server points at `/mcp auth` instead of a generic connection failure, cancel the authorization wait immediately when its signal is already aborted, and document non-interactive (`agentj run`) behavior and the fallback for servers without dynamic client registration.

## 0.1.0-next.15

### Patch Changes

- 27608f0: Show guided next-argument options immediately after accepting slash-command completions such as `/config`.

## 0.1.0-next.14

### Patch Changes

- 0a65f20: Large pastes collapse to a `[pasted content #N: X chars]` placeholder in the editor (expanded back on submit), and the live region is clamped to the terminal height — a paste taller than the window previously corrupted every repaint, duplicating the screen into scrollback. Resuming a session no longer fails with `cannot lock ref refs/agentj/undo/...`: the undo stack continues its ref counter from the previous run and keeps those snapshots undoable.

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
