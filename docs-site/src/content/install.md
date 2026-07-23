# Install

## The CLI

```bash
npm i -g @glrs-dev/cli
```

This installs the unified `glrs` binary. Then register the harness plugin:

```bash
glrs harness install
```

Launch OpenCode — agents, commands, tools, and skills load automatically:

```bash
opencode
```

## Subcommands

| Command | What it does |
|---------|-------------|
| `glrs harness` | Plugin management (install, configure, uninstall, doctor) |
| `glrs assume` | Cloud credentials (init, login, contexts, agent MCP) |
| `glrs wt` | Worktree management (create, list, switch, delete, cleanup) |
| `glrs autopilot` | Autonomous scope → plan → execute orchestrator |
| `glrs loop` | Raw prompt loop runner |
| `glrs upgrade` | Self-update to latest version |

## Cloud credentials (optional)

```bash
glrs assume init
```

Installs the latest `@glrs-dev/assume` (clearing the deprecated `@glorious/assume`), migrates any legacy `gs-assume` config forward, runs login, approves agent contexts, requires a default context, and configures MCP. Re-run any time to repair a broken install.

## Requirements

- **Bun ≥ 1.2.0** on PATH — install from [bun.sh](https://bun.sh)
- **macOS or Linux** on x64 or arm64
- **GitHub CLI** (`gh`) for GitHub-interacting commands
