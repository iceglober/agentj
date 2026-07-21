# @glrs-dev/aj

## 0.1.0-next.50

### Patch Changes

- 5c76c02: Keep transcript events in emission order and use semantic spacing so background completions appear where they occurred without adding extra blank rows between related events.
- 1b1500e: Prevent MCP stdio startup diagnostics from being written directly to the terminal, keeping the TUI intact while preserving the normal MCP failure and reload guidance.

## 0.1.0-next.49

### Patch Changes

- 5ba7e3b: Rename the primary agent's background-job tools to `run_background_job` and `check_background_job` to distinguish detached work from foreground subagent delegation.

## 0.1.0-next.48

### Minor Changes

- 82f6cc7: Improve the live TUI layout by keeping todos inside their bordered panel, showing overflow as a footer, and placing tool and message progress above the todos while thinking remains directly above the editor.

### Patch Changes

- e14e98d: Prevent oversized tool results and resumed tool history from exceeding model-provider input limits by bounding model-bound output while preserving full content in spill files.
- dbff49c: Clarify that Tab only changes mode, while `/build` starts implementation; `/build` also forwards any additional feedback into the implementation turn.
- a8ab61a: Increase retry coverage for transient model responses such as rate limits, giving requests more time to recover while preserving cancellation and existing network retry behavior.
- 0dc5740: Render structured background-job results as readable labeled text instead of raw JSON.

## 0.1.0-next.47

### Patch Changes

- 588ea2c: Release pull requests now use the repository's trusted release token, so a Changesets version PR can run its checks without waiting for manual workflow approval.

## 0.1.0-next.46

### Minor Changes

- ed342a6: Add a built-in checking-your-work plan review so aj plans now name a bug repro, focused and broad checks, and browser testing when it applies.
- fe6f6a4: Make interactive question choices easier to scan and let users enter answers that are not listed.

### Patch Changes

- 0145b2d: Keep the persistent Todos panel visually separate from live tool activity, with clear completed, active, and pending markers. For example, several active tasks now each use an arrow and are counted in the panel header instead of blending into a running tool spinner.
- 05a3c17: Installed interactive sessions now check for updates after the TUI starts and notify instead of auto-installing or restarting. The `update.auto` setting controls the check; `/update` remains explicit.
- cd7f7f3: Background job completions now follow the foreground output that was already being written to the interactive transcript.

## 0.1.0-next.45

### Minor Changes

- 6189528: AgentJ now continues work while session todos remain open instead of ending a turn early. For example, after a background CI job finishes, AgentJ receives its result and resumes the remaining verification and follow-up work without waiting for you to type `continue`.

## 0.1.0-next.44

### Minor Changes

- 81526df: Plan-mode reflections now ask agents to describe how a proposed change will leave the code simpler, including which existing abstractions they will reuse, extend, remove, or create. For example, a refactor plan now identifies the shared boundary it will use instead of adding another duplicate helper.

### Patch Changes

- ce0e874: Use clear words for agent status, validation, jobs, and context limits. For example, an active background job now reports “In progress” with its next step instead of a bare `!`.

## 0.1.0-next.43

### Minor Changes

- 1833603: Add model-only `creating-agent-skills` and `using-the-browser` embedded skills. The browser skill includes Playwright CLI guidance, references, and its Apache-2.0 license.
- b20dae5: Plan mode can now run named, parallel reflections after it first drafts a plan. Configure `agent.reflections.prompts` with reviews such as an architecture check and a testing check; AgentJ shows their live progress, records a compact `Reflections: …` transcript marker, and uses their findings to produce one revised plan while retaining the original draft if reflection fails.
- 95bb66a: Interactive agentj chats can now ask focused structured questions with described choices, multi-select answers, or free text. For example, when a request leaves scope unclear, agentj can present CLI and TUI options with short descriptions and return the selected answer before it continues work.
- a575786: Agentj can now research the public web in any model mode without a model-provider web feature or API key: `web_search` finds current sources through the built-in anonymous search service, while `web_fetch` reads a specific public URL as text. For example, an agent can search for a library’s current release notes, then fetch its documentation page to verify an API detail; fetched content is marked untrusted and outbound web access can be allowed, asked, or denied with `permissions.web`.

### Patch Changes

- 2b6b1ee: Improve the status area on narrow terminals by preserving session and labeled token details where they fit, such as showing `in 2.0m ▸ out 24.6k · ctx 60.0k`, while safely shortening paths, job prompts, and Unicode text without clipping. Standard-width layouts remain unchanged.

## 0.1.0-next.42

### Minor Changes

- afc8ae2: Completed session todos now collapse to a compact summary such as `Todos 3/3`, keeping the live chat area clear until new work is added. When a longer active list does not fit, `/todos` prints every current todo so you can inspect the full plan.

### Patch Changes

- d3c13cc: Background jobs now render structured completion reports as normal status, change, and validation text instead of raw JSON; for example, a completed ship job reports its merged pull request and checks cleanly while clearing the completed session checklist.

## 0.1.0-next.41

### Minor Changes

- b77a352: Add a `/release` skill that finds the open Changesets `Version Packages` pull request, safely squash-merges its recorded revision, and reports the released package versions and generated changelog; for example, it replies that nothing needs releasing when no such pull request is open.
- b51bac8: Agentj can now delegate one independent task with `run_one_subagent` or coordinate several with `run_subagents`, making small delegation as easy as sending a prompt while retaining DAG support for larger work. The interactive chat also stays quiet while tools run: it prints one completion receipt such as `✓ 3 tools · 2.1s · /activity for details`, and `/activity` shows the completed tool history when you want it.

### Patch Changes

- 7ef3207: Multiline prompts now keep their line breaks in the interactive transcript. For example, sending a prompt with a blank line between two paragraphs now displays that same blank line above the agent response instead of joining the paragraphs onto one row.

## 0.1.0-next.40

### Minor Changes

- 9aefbac: AgentJ now layers project configuration from `.aj/config.json` and `.aj/config.local.json` above canonical global configuration at `~/.config/aj/config.json`. Existing `~/.config/agentj/config.json` files remain a fallback until a canonical global config exists.

## 0.1.0-next.39

### Minor Changes

- 3908a3b: Agentj can now maintain a session todo list for multi-step work: for example, it can show a live checklist while it investigates, implements, and tests a feature. The list persists when you resume the chat and `/clear` removes it with the chat context.

### Patch Changes

- 3728352: Recognize Git's canonical worktree paths when finalizing background jobs, preventing clean macOS `/var` worktrees from being preserved as unregistered.
- 2942eb7: Skills can set top-level `user-invocable: false` in SKILL.md frontmatter to remain available to the model without registering a slash command. The bundled `running-background-work` skill now uses this setting.

## 0.1.0-next.38

### Minor Changes

- cec13aa: The chat editor now highlights `/build`, `/bld`, and other slash input in teal only while it matches an available command, skill, or MCP prompt; typing an unmatched query returns it to normal text. Tool activity rows now retain concise call arguments after completion, so a finished command can show `✓ bash git status --short` instead of only `✓ bash`.

## 0.1.0-next.37

### Patch Changes

- 5b400a2: Background build jobs that finish their work but cannot remove a child worktree now complete with a cleanup warning instead of being reported as failed. For example, a job that merges a pull request and then hits a worktree cleanup error reports `done`, shows the exact warning, and preserves its recovery branch when needed.

## 0.1.0-next.36

### Minor Changes

- fee71df: Add the built-in `/running-background-work` skill so aj can guide long-running work such as waiting for CI or deploying: it starts an appropriate background job instead of claiming that it will wait in the foreground.

### Patch Changes

- fee71df: Show the current aj version at the right of the TUI status path row.
- fca59d8: Show `run_job` in the terminal's normal tool activity transcript, so starting a background task now produces a row such as `✓ run_job` alongside its existing job start and completion updates.

## 0.1.0-next.35

### Patch Changes

- 95188a0: Ground completion claims in the turn's actual tool activity. AgentJ no longer reports `status=done` when it ran no tools that turn — such a report is fabricated (it fills the completion-report template from the plan text without doing or validating the work), so it is rejected and the model gets one corrective retry, then an explicit failure report. The same primitive still verifies background-job claims: saying it is monitoring work requires a started job. Both checks now live in one grounding gate (`completion-grounding.ts`) instead of separate per-symptom guards. The `gpt-5.6-sol` and `gpt-5.6-terra` profiles also re-enable the evidence rule (`hallucinationGuard`), which the subtractive 5.6 prompt guidance had dropped, so the model is told never to claim a test result it has not observed via a tool this session.
- 95188a0: Remove auto-compaction. The `agent.context.onLimit` config no longer accepts `compact`; crossing the context soft limit always posts a wrap-up/delegate notice (`warn`). Auto-compaction flattened the full conversation into a single model-authored summary, which discarded out-of-band state (live background jobs, current plan/build mode) and left the model narrating a stale, authoritative-looking history. Deleting it also drops the delegate-tier compactor runtime and the `AgentRuntime.compact` / `Agent.compact` surface.

## 0.1.0-next.34

### Patch Changes

- 59494e2: AgentJ now treats the controller-selected mode as authoritative on every turn. For example, after switching from plan to build, an older plan-mode refusal in the conversation no longer makes the agent claim that editing is unavailable.

## 0.1.0-next.33

### Minor Changes

- 37504f9: The chat editor now fuzzy-completes slash commands and project file references wherever the token starts at the beginning of input or after whitespace. For example, type `review @agt` and press Tab to insert a matching project file, or type `review /bld` to complete `/build` without turning surrounding prose into a command. Slash commands use cyan, file references use green, and a leading `&` switches the editor to a clear yellow `BACKGROUND JOB` state. Structured agent completion reports now keep their changes, validation evidence, and open questions in the transcript instead of showing only a summary.
- 746e38e: Projects can configure scoped Markdown instruction extensions, such as a plan-only architecture checklist in `.aj/extensions/plan.md`, and use typed `agentj.ts` configuration.
- 06854b8: `agentj config` now organizes documented settings into nested searchable menus with Back navigation. Secret edits use the masked prompt and save to the OS keychain correctly.

### Patch Changes

- ec5096c: `/clear` now starts a fresh chat context instead of only erasing terminal output. It removes prior conversation history and foreground cost data from the active and resumed session, clears the terminal, and keeps the selected mode and running background jobs.
- 06854b8: Background build jobs now use unique, repository-scoped child worktrees and report setup or integration failures as failed instead of incorrectly reporting them as done. For example, a stale temporary worktree from another project no longer prevents `run_job` from starting.

## 0.1.0-next.32

### Minor Changes

- 903aed6: `agentj config` with no subcommand now opens an interactive editor. It lists the configurable keys with their current values and lets you edit each with the right control for its type — a menu for enums, true/false for booleans, masked entry for the provider key, a numeric field, or an add/remove list for arrays like `agent.llm.tiers` — persisting through the same path as `config set`. The subcommands (`config get`/`set`/`delete`) are unchanged; non-interactive use still errors cleanly.
- d5abe0d: Editing a list-valued config key no longer means typing raw JSON. `/config set agent.llm.tiers` (and any array key) now opens a guided list editor — add, edit, delete, and reorder items (order matters for the model ladder) — instead of asking for `["a","b"]`. Under the hood a new schema-field layer reads each config key's type straight from the zod schema, the groundwork for onboarding and a full config screen.
- 925f4ed: First run no longer dead-ends on a missing key. Starting `agentj` interactively without a provider key configured used to print "Azure API key missing" and exit; it now walks you through entering the key (masked, stored in your OS keychain) and continues straight into a session. The model already has a working default, so that key is the only step. Non-interactive runs (`agentj run`, pipes) keep the plain error.
- c74df62: Allow Ctrl+V to attach copied screenshots as vision input, and send supported `@` image files as vision attachments.

### Patch Changes

- ea1b4b0: Plan mode now hands off in one gesture. A plan closes by naming the single most likely next action, so accepting collapses to pressing Tab or `/build` instead of restating what you obviously want. The stop rules also lean less on "should I?": when the conversation already implies the answer the agent states the assumption and acts (build) or names it in a line (plan) — while still asking before anything permission-gated, destructive, or outward-facing.

## 0.1.0-next.31

### Patch Changes

- 094988e: Fixes the unpredictable blank rows in the chat transcript at the source. The live region (editor, progress, status) was glued to the terminal's bottom by hand-tracked scroll bookkeeping; because that region changes height on every event mid-turn (a tool row appears, the thinking line toggles), the bookkeeping drifted from the real terminal state and deposited a variable band of blank rows — the height of the region at that instant — between transcript lines. The region now floats directly beneath the transcript using the terminal's own scrolling, with no scroll state to desync, so transcript lines always sit one row apart. When the transcript is short the editor rests just under the last line rather than at the very bottom of the window.
- 135d0ea: Ctrl+V now tells you what happened instead of doing nothing. It attaches files copied in your file manager (Finder, etc.) as `@references`; previously, if the clipboard held no files — because you copied text, copied nothing, or the copy wasn't detected — the key silently did nothing, which was indistinguishable from a broken feature. It now shows a notice explaining what the key is for and that terminal paste (⌘V) is how you paste text, and any clipboard read error is surfaced rather than swallowed.

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
