# agentj

A simple, effective terminal coding agent — same category as Claude Code and Opencode. It
reads and writes files in your repo, runs shell commands, and calls a model in a loop until
the task is done. One package, no server, no worktrees: it works directly in your current
checkout, and **you** own git as the safety net.

## Requirements

- **[Bun](https://bun.sh) 1.2+** — the runtime and package manager. There is no build step; Bun runs the TypeScript directly.
- **A model provider** (pick one): Google Vertex AI (Gemini, default) or Anthropic (Claude). See [Set up a provider](#set-up-a-provider).
- **git** *(optional)* — used to scope `glob`/`grep` to non-ignored files. Without a git repo, agentj runs in place and walks the filesystem instead.

## Install

```sh
git clone https://github.com/iceglober/coder
cd coder
bun install
bun bin/agentj --help
```

## Set up a provider

agentj runs a **preflight** credential check before each run and tells you exactly what's
missing rather than failing mid-stream.

**Vertex / Gemini (default)** — authenticate once, then point agentj at your project:

```sh
gcloud auth application-default login
export GOOGLE_VERTEX_PROJECT=your-gcp-project-id
export GOOGLE_VERTEX_LOCATION=global   # optional; "global" serves every Gemini model
```

**Anthropic / Claude** — set a key and select the provider per run (or via `AGENTJ_PROVIDER`):

```sh
export ANTHROPIC_API_KEY=sk-ant-...
bun bin/agentj --provider anthropic
```

**Azure AI Foundry** — agentj talks to Foundry's OpenAI-compatible endpoint. Azure addresses models by
the **deployment name you choose**, so there's no default — name one with `--model`:

```sh
export AZURE_BASE_URL=https://<resource>.services.ai.azure.com/models
export AZURE_API_KEY=...
export AZURE_API_VERSION=2024-10-21          # optional; some endpoints require it
bun bin/agentj --provider azure --model <your-deployment-name>
```

**Custom / OpenAI-compatible** — any OpenAI-compatible endpoint: an LLM gateway (e.g.
[Bifrost](https://github.com/maximhq/bifrost)), a local server, or a self-hosted model. Point agentj at
the base URL and name a model:

```sh
bun bin/agentj --provider custom --base-url http://localhost:8080/v1 --model <model-id>
export AGENTJ_API_KEY=...                      # optional; sent as a Bearer token
# or via env: AGENTJ_BASE_URL, AGENTJ_MODEL, AGENTJ_PROVIDER=custom
```

## Run it

`bun bin/agentj` (or `bun run agentj`) starts an interactive chat in the current repo. The agent
runs in-process — no server, no port.

```sh
bun bin/agentj                                          # interactive chat (current repo)
bun bin/agentj --once "add a --json flag to the export command"   # run one task, then exit
bun bin/agentj --provider anthropic --model claude-opus-4-8       # pick provider + model
```

- **Permissions are auto.** The agent edits files and runs commands without prompting — you own
  git (commit, branch, or stash before a risky task; revert after).
- **Ctrl-C** interrupts the running turn and returns you to the prompt. **Ctrl-D** or `/exit`
  quits. The terminal is always restored on exit.

### Options

| Flag | Values | Default | Env |
|---|---|---|---|
| `--provider` | `vertex` `anthropic` `azure` `custom` | `vertex` | `AGENTJ_PROVIDER` |
| `--model` | exact model id (required for azure/custom) | per-provider default | `AGENTJ_MODEL` |
| `--base-url` | endpoint for `--provider custom` | — | `AGENTJ_BASE_URL` |
| `--once` | `"<task>"` — run one task headlessly, then exit | — | — |
| `-h`, `--help` / `-v`, `--version` | | | |

Default models: Vertex → `gemini-2.5-pro`, Anthropic → `claude-opus-4-8` (azure/custom have no default
— name one with `--model`).

### Long tasks: supervised auto-continue

The loop runs in windows of `AGENTJ_MAX_STEPS` steps (default 40). A window is a *runaway guard*, not
a "you're done" signal — when the model burns a full window while still working, agentj asks a cheap
supervisor (one structured model call over a tail of recent activity) whether it's making progress:

- **Progressing** → agentj prints `» auto-continuing (n/N) — <guidance>` and runs another window.
- **Stuck / off track** → agentj prints `» stopping: <reason>` and returns to the prompt.
- **Ceiling reached** → after `AGENTJ_MAX_CONTINUES` extensions (default 3) it stops with a note telling
  you to type `continue` (history is preserved) or raise the limits. It never stops *silently*.

| Env | Default | Effect |
|---|---|---|
| `AGENTJ_MAX_STEPS` | `40` | steps per window |
| `AGENTJ_MAX_CONTINUES` | `3` | auto-continue extensions past the first window (`0` disables it) |
| `AGENTJ_STEER_MODEL` | (main model) | model for the supervisor check — set a cheaper one, e.g. `gemini-2.5-flash-lite` |

## MCP servers (Linear, GitHub, etc.)

agentj connects to [MCP](https://modelcontextprotocol.io) servers and exposes their tools to the
agent, alongside the built-in file/exec tools. It reads **Claude Code's `.mcp.json` format**, so
an existing config works unchanged — a repo `.mcp.json` (project root) merged over a global
`~/.agentj/.mcp.json` (repo wins):

```jsonc
{
  "mcpServers": {
    "linear":  { "type": "http", "url": "https://mcp.linear.app/mcp" },         // OAuth (browser)
    "github":  { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                 "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" } }, // static token
    "local":   { "command": "npx", "args": ["-y", "some-mcp-server"] }           // stdio
  }
}
```

- **stdio** (`command`/`args`/`env`), **remote** (`type: "http"|"sse"`, `url`, `headers`). String
  values support `${VAR}` / `${VAR:-default}` expansion — that's how you supply tokens.
- Servers connect **once at startup**. A server that fails or needs login is skipped with a
  one-line notice; the rest of the session continues with the tools it does have.
- **OAuth** servers (like Linear) authenticate the same way Claude Code does: dynamic
  registration (no app to create) + browser, tokens stored in `~/.agentj/auth.json` (mode 0600)
  and refreshed automatically. Authorize up front:

```sh
bun bin/agentj mcp list             # configured servers + auth status
bun bin/agentj mcp login linear     # OAuth in the browser
bun bin/agentj mcp logout linear    # forget stored tokens
```

  A server with a static `Authorization` header skips OAuth entirely. Tools appear to the agent
  as `<server>__<tool>` (e.g. `linear__create_issue`).

## Layout

```
agentj/
  bin/agentj              # binary entry — imports main() from the agent package
  packages/agentj/        # the whole agent:
    src/index.ts         #   CLI: flags, `mcp` subcommands, chat / --once
    src/chat.ts          #   interactive loop (line reader + renderer)
    src/agent.ts         #   the model loop (Vercel AI SDK ToolLoopAgent)
    src/tools.ts         #   built-in tools: read/write/edit/ls/glob/grep/bash
    src/exec.ts          #   detached-process-group command runner (Ctrl-C kills the tree)
    src/model.ts         #   provider resolve (vertex/anthropic/azure/custom) + preflight
    src/render.ts        #   raw-ANSI streaming transcript + heartbeat status line
    src/input.ts         #   raw-mode line reader (manual echo, cooked fallback)
    src/mcp/*            #   .mcp.json config, client, OAuth, token store, AI-SDK adapter
  test-projects/         # eval harness — fixed projects + tasks (see note below)
  docs/                  # historical design notes (describe a prior architecture)
```

## Develop

```sh
bun run typecheck     # tsc --noEmit
bun run test          # bun test
bun bin/agentj --help
```

**Eval harness** — run agentj against a fixed set of real tasks (pnpm-vitest / pytest / go), each in a
throwaway copy, graded objectively (`verify` exits 0, `expect` substrings appear, `expectNoChange`, or
an LLM `judge` scores an open-ended design). Needs Vertex creds.

```sh
bun test-projects/run.ts          # all tasks
bun test-projects/run.ts py       # only tasks whose id contains "py"
KEEP=1 bun test-projects/run.ts   # keep the throwaway dirs to inspect the diff
```

> **Note:** the `docs/PLAN*.md` notes still describe the previous multi-package architecture.

## License

MIT — see [LICENSE](LICENSE). Self-contained; multi-provider via the Vercel AI SDK.
