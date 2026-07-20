# agentj

A terminal coding agent — same category as Claude Code and OpenCode. It runs as a persistent chat
session in your repo: you talk, it reads and edits files, runs commands, and fans out parallel
subagents, with **plan** and **build** modes you toggle with Tab or `/build`. Host-first, gated by a
permission system; git (plus built-in undo) is the safety net.

The implementation lives in [`core/`](core/) — a Bun TypeScript agent.

## Requirements

- **[Bun](https://bun.sh)** — the runtime. Install once; no separate build step.
- **A model provider** — wired: **Azure AI Foundry**.
- **git** — sessions run inside a git worktree; undo, subagent isolation, and search scoping use it.

## Run it

```sh
bun add --global @glrs-dev/aj@next       # install the prerelease channel
git clone git@github.com:iceglober/agentj.git && cd agentj  # or develop from source
```

```sh
bun run agentj                         # open a chat session in this repo (plan mode)
bun run agentj -- --continue           # reopen the newest session for this project
bun run agentj -- --resume <id>        # reopen a specific session
bun run agentj -- run "add a --json flag"              # non-interactive one-shot (build)
bun run agentj -- run --plan "how does auth work?"     # non-interactive, read-only
bun run agentj -- run --allow-all "fix the tests"      # asks auto-resolve to allow
./bin/agentj config set agent.llm.model gpt-5.6-sol
./bin/agentj config set agent.tools.subagents.model gpt-5.6-luna  # tier-route fan-out work
./bin/agentj config set --secret providers.azure.api_key
agentj update --channel next             # update an installed CLI now
./bin/agentj eval | eval report | eval selfcheck
./bin/agentj --help
```

## The chat session

You start in **plan mode**: the agent's tools are read-only — it can investigate, fan out research
subagents, and present a plan, but it cannot edit anything. Press **Tab** to switch to **build
mode** (full tools), or enter **`/build`** to switch and immediately ask the agent to implement the
work agreed on in the conversation. These are explicit approval gestures; there is no magic
approval phrase.

Keys and commands:

- **Tab** — complete the selected slash-command or `@file` suggestion, or toggle plan/build when
  no suggestions are shown (applies at the next turn if one is running).
- **Esc** — dismiss slash-command suggestions, dequeue the newest waiting message back into the
  editor, or interrupt the running turn. The session survives; the model is told it was cut short.
- **Ctrl+C** — clear the input; on empty input it interrupts, and a double press quits.
- **Enter** — complete the selected slash command, or send when the command is exact or no
  suggestions are shown. **Shift+Return** — newline. Outer whitespace is trimmed when routing a
  message; internal blank lines are preserved. Messages typed mid-turn are queued.
- **↑/↓** or **Ctrl+P/N** — select a shown slash-command or file suggestion, or browse recent
  submitted prompts from an empty editor.
- **`& <task>`** — run the task as a background job in the current mode. When `&` is the first
  editor character, the editor turns yellow and shows `BACKGROUND JOB`. Jobs run in their own
  worktree (build) or read-only (plan), never race your checkout, and report into the transcript
  and the next turn. `/jobs` lists them; `/jobs abort <id>` stops one. The agent can also start
  jobs itself (`run_background_job`) — asked to wait on something external like a CI run or a review, it
  detaches the wait instead of blocking the conversation. A job may carry a renewable soft
  timeout: if it is still running at the deadline the agent gets pinged, inspects the job's
  recent activity (`check_background_job`), and either extends the deadline or aborts a stuck job — the
  job itself keeps running throughout. The bundled `running-background-work` skill guides the
  model through this workflow for waits, reviews, releases, deploys, and delayed merges; it is not
  a slash command.
- **`@path/to/file`** — attach a file's contents to your message. Type `@` after whitespace to
  fuzzy-match project files; Tab or Enter inserts the selected path. Supported image files (`.png`,
  `.jpg`, `.jpeg`, `.gif`, `.webp`) are sent as vision input. Quote paths with spaces as
  **`@"path/to/my file.md"`**. **Ctrl+V** inserts copied local files or copied screenshots as
  editable references.
- **`/build`** — switch to build mode and implement the plan and discussion so far. Typing `/`
  after whitespace shows fuzzy-matched command suggestions; inline tokens complete and highlight
  but only a top-level slash command executes locally.
- **Structured questions** — the interactive primary agent can ask focused questions with described
  choices, multi-select answers, or free text. This is unavailable in one-shot runs, background
  jobs, and subagents.
- **`/mcp`** — inspect MCP status; guided completions provide `add`, `auth`, `reload`, `remove`,
  and advanced `set` actions. Server prompt templates appear as namespaced commands such as
  **`/mcp:docs:summarize`**; built-in commands always win. Invoking one collects its arguments
  interactively, then sends bounded, explicitly labeled external content as a normal user turn.
  Successful configuration changes reload automatically and become available on the next foreground turn.
- **`/config get|set|delete`** — inspect or update canonical global configuration with path/value completion.
  Omitting a sensitive value opens a masked prompt.
- **`/model [primary|subagents]`** — choose a provider and model in a guided prompt. Changes are
  saved globally and apply to new turns/jobs immediately; subagents can instead inherit the primary.
- **`/cost`** — per-model foreground token usage for this session (including resumed history):
  input split into no-cache / cache-read / cache-write, output, requests past Azure's 272k
  long-context tier, and USD priced from the `eval.prices` $/Mtok map (models without a price show
  `$ n/a`; cache reads are priced at the input rate). Usage persists per turn in the session log;
  subagent and background-job tokens are not included.
- **`/update [next|latest]`** — exit cleanly and update the installed CLI. Omit the channel to keep
  the current release track.
- **`/help /jobs /undo /redo /clear /quit`** — other built-in commands. `/undo` and `/redo` step
  the agent's file changes through git snapshots without touching your HEAD, index, or branch.

Skills in `.aj/skills/<name>/SKILL.md` are available to the model. They register a `/name` command
by default; set `user-invocable: false` in the SKILL.md frontmatter to keep a skill model-only.

Editor shortcuts: Ctrl+V pastes copied local files as `@file` references or screenshots as
`[pasted image #N]` markers. Prompts with pasted images are not added to prompt history.
Option+←/→ word hop, Option+Backspace/Delete word delete, Cmd+←/→ line bounds,
Cmd+Backspace/Delete delete to bound; Home/End, Ctrl+A/E/U/K, and Esc+B/F/D fallbacks work in any
terminal. Shift+Return and Cmd combinations need a modifier-aware terminal protocol (CSI-u — kitty,
WezTerm, Ghostty, or mapped keys in iTerm2).

## Web research

`web_search` searches the public web through Exa's anonymous MCP endpoint; no API key or model-provider
web tool is required. `web_fetch` reads a specific public HTTP(S) URL locally and returns Markdown/text.
Both tools are available in plan and build modes, including research workers and jobs. Search results and
page content are labeled untrusted: they are reference material, not instructions. URL fetching blocks
private, loopback, link-local, and reserved network addresses, follows bounded redirects, and limits time
and response size.

## Updates

Installed interactive sessions check for updates after the TUI starts and notify you when one is
available; they never auto-install or restart. Prerelease versions follow the `next` tag and stable
versions follow `latest`. The check is controlled by `update.auto`:
`agentj config set update.auto false` disables it, while `agentj config set update.channel next`
selects a persistent channel. Use `/update [next|latest]` explicitly to install an update;
source checkouts are never modified.

## Permissions

Host-first execution is gated at the tool layer. Repository read/search tools are never gated; web
research has its own policy, and plan mode has no mutating tools. In build mode:

```sh
./bin/agentj config set permissions.edit allow            # allow | ask | deny (default allow)
./bin/agentj config set permissions.web ask               # outbound web search/fetch (default allow)
./bin/agentj config set permissions.bash.default ask      # unlisted commands ask
./bin/agentj config add permissions.bash.allow "git *"    # literal prefix, optional trailing *
./bin/agentj config add permissions.bash.deny "git push*"
```

The complete, terminal-escaped request is printed into the transcript before the inline controls
(`[y]es once · [a]lways this session · [n]o`) appear; concurrent asks are queued. Session-wide
approval applies only to policy outcomes of `ask`; configured denies remain authoritative.
In `agentj run` there is no TTY: asks resolve to deny with a notice unless `--allow-all` is passed. A
denial is returned to the model as a tool result, so it adapts instead of crashing the turn.

## MCP tools and resources

Agentj connects configured [Model Context Protocol](https://modelcontextprotocol.io/) servers over
stdio or Streamable HTTP. Interactive startup does not wait for MCP: servers connect independently
in the background, and one failed server cannot block Agentj or another server. MCP capabilities are
available only to the primary agent; subagents and background jobs do not inherit the connection.

Configure a project-local stdio server in `.aj/config.json`:

```json
{
  "mcp": {
    "servers": {
      "github": {
        "transport": "stdio",
        "command": "github-mcp-server",
        "args": [],
        "envFrom": { "GITHUB_TOKEN": "GITHUB_TOKEN" },
        "tools": { "plan": ["search_*", "get_*"], "build": ["*"], "direct": ["search_code"] },
        "resources": { "plan": ["docs*"], "build": ["*"] }
      }
    }
  }
}
```

`envFrom` maps a child-process variable to a source variable in agentj's environment. Relative
`cwd` values resolve from the project root. Stdio servers inherit only the MCP SDK's safe baseline
environment plus configured values.

For a remote server, use Streamable HTTP and environment-derived headers:

```sh
./bin/agentj config set mcp.servers.docs '{
  "transport":"http",
  "url":"https://mcp.example.com/mcp",
  "headersFromEnv":{"Authorization":"MCP_AUTH_HEADER"},
  "tools":{"build":["*"]},
  "resources":{"build":["*"]}
}'
```

Tool and resource patterns are exact names with an optional trailing `*`. Plan lists default to
empty; build lists default to all. Adding a tool to `tools.plan` explicitly certifies it as safe for
read-only planning. Tools in `tools.direct` are exposed with their native JSON schemas. All other
eligible tools stay in a bounded catalog accessed through `find_mcp_tools` and `call_mcp_tool`,
which avoids sending every server schema to the model. Resources similarly use
`find_mcp_resources` and `read_mcp_resource`, including URI templates. Catalogs refresh lazily when
a server sends a list-change notification. Server prompt templates are likewise discovered with
pagination and invoked as `/mcp:<server>:<prompt>` (for example, `/mcp:github:review-pr`).
Their required and optional arguments are collected in terminal prompts rather than command text.
Returned prompt messages, including text embedded in resources, are bounded and labeled as
untrusted external instructions before being submitted through the normal chat path; this preserves
the opaque model continuation and works unchanged after a session is resumed. `/mcp reload [name]` reconnects one or all servers;
successful replacements (including direct-tool changes) activate at the next foreground turn. If a
reload fails, an existing working connection stays active and `/mcp` shows a deterministic recovery
hint when Agentj can identify one. External file or environment changes require a manual reload.

Build-mode MCP calls default to `ask` and are authorized by canonical names such as
`mcp_github_search_code`, including calls routed through the generic catalog tool:

```sh
./bin/agentj config add permissions.mcp.allow "mcp_github_search_*"
./bin/agentj config add permissions.mcp.deny "mcp_github_delete_*"
```

Credentials can also be supplied as static `env` or `headers`, but environment mappings avoid
persisting them in config. For hosted servers that advertise OAuth on their 401 challenge,
`/mcp auth <http-server>` runs the OAuth 2.1 flow: metadata discovery, dynamic client registration,
PKCE, and a browser round-trip to a localhost callback. Access and refresh tokens live in the OS
keychain, never in the configuration file, and expired tokens refresh automatically on later
connects. Non-interactive contexts — `agentj run` and every background connect — never open a
browser: saved tokens are used and refreshed, and a server that was never authorized fails with a
notice pointing at `/mcp auth`, so authorize once interactively before non-interactive use. When a
server does not support OAuth or dynamic client registration, the same command falls back to a
masked Authorization-header prompt; that value is omitted from terminal and prompt history but
remains plaintext in the existing configuration file format, so prefer `headersFromEnv` for
long-lived keys. MCP support does not include legacy HTTP + SSE. Delegates and background build
jobs receive no MCP capability unless a server opts in with `inherit`: HTTP servers may declare
`inherit: "shared"` (children get a read-only view of the primary connection's catalog — they can
call tools but never reload, close, or refresh it), and stdio servers may declare
`inherit: "isolated"` (each child gets its own server process rooted at its worktree, closed
deterministically when the child finishes). Children's MCP calls ride the same `permissions.mcp`
policy, with asks labeled by the requesting subagent or job.

## Parallel subagents

In both modes the agent has `run_subagents`: a task DAG (`waitsOn` between tasks) executed with
bounded concurrency. Plan mode fans out read-only researchers; build mode gives each child an
isolated git worktree and integrates the results back as a batch — a child failure preserves its
branch instead of losing work. Running DAG state stays in the live region, then a final task summary
is retained in the transcript. `/model subagents` routes children to another provider/model or
restores primary-model inheritance; the equivalent config paths are
`agent.tools.subagents.provider` and `agent.tools.subagents.model`.

## Sessions and persistence

Every session appends to one JSONL log under `$XDG_STATE_HOME/agentj/chats/`. `--continue` /
`--resume <id>` restore the conversation (including the model's tool-call memory), its todo list,
and recent turns. For multi-step work, the agent maintains that list with `update_todos`; it stays
visible in the terminal live region and clears with `/clear`. Crash-safe by construction: a torn
final line is skipped on load.

## Evals

`core/eval/` holds the eval harness: fixture-based tasks (Python and TypeScript), deterministic
graders plus trajectory/report checks, seeded-defect and punch-list task sources, and a selfcheck
gate proving every task solvable and falsifiable. Eval runs use the Microsandbox adapter; the
interactive agent itself is host-first. See `bun run agentj -- eval --help`.

## Development

```sh
bun test core        # unit tests
bun run typecheck
bun run check        # biome lint + format
bun run agentj -- eval selfcheck   # model-free eval QA gate
```
