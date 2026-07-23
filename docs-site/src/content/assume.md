# Assume

SSO credential manager for AWS and GCP. Authenticate once, switch contexts per-shell, credentials auto-refresh.

## Install

```bash
glrs assume init
```

One command. It:

1. Installs the latest `@glrs-dev/assume` (and removes the deprecated `@glorious/assume`, whose stale `gsa`/`gs-assume` bins can shadow the current one).
2. Migrates a pre-rebrand `gs-assume` config directory forward, so you keep your providers, contexts, and credentials.
3. Runs login, lets you approve contexts for agent access, and **requires you to choose a default context** (what agents and `gsa exec` use when no context is pinned).
4. Configures the MCP server for your agent tools.

Until `gsa init` completes, gsa is inert — every command except `init`, `upgrade`, `shell-init`, `status`, and `config` refuses and points you back to `gsa init`. This prevents a half-configured state where the daemon runs but no default context exists.

Re-run `gsa init` any time to repair a broken install or change your default context. Pass `--default-context <pattern>` to set it non-interactively.

Or install standalone: `npm i -g @glrs-dev/assume`

Bins: `glrs-assume`, `gsa` (alias).

## How it works

1. **`gsa init`** — one-time setup: authenticates (opens browser), approves contexts for agent access, and picks a **default context**. Until init completes, every other command refuses (see Install).
2. **`aws s3 ls`** — just works. A local daemon serves your default context's credentials to the AWS SDK; tokens auto-refresh. (Requires the shell integration below.)
3. **`gsa use aws prod`** — switch *this shell* to a different context. Each shell has its own active context — shell 1 can be in `dev` while shell 2 is in `prod`.

`gsa use` overrides the default for the current terminal only; the default context (set during init) is what every other shell and agent get.

## Contexts

A context is an identity you can switch to — an AWS account + role pair, or a GCP project. Contexts are discovered automatically from your SSO provider during `gsa init` (and refreshed with `gsa sync`).

```bash
gsa init                     # first-time: authenticate + discover contexts + set a default
gsa use aws dev              # fuzzy-match and activate a context for this shell
gsa use aws                  # no pattern — opens TUI picker
gsa use aws prod --pin       # pin to this terminal only
gsa sync aws                 # re-fetch contexts after IAM changes
```

## Commands

### Authentication

| Command | What it does |
|---|---|
| `gsa login [provider]` | Browser SSO auth. Discovers available contexts. |
| `gsa logout [provider]` | Clear stored credentials. |
| `gsa status` | Token expiry, active context, daemon health. |

### Context switching

| Command | What it does |
|---|---|
| `gsa use <provider> [pattern]` | Activate a context in this shell (fuzzy match). TUI picker if no pattern. |
| `gsa contexts [provider]` | List all available contexts with tags. |
| `gsa sync [provider]` | Re-fetch contexts from provider APIs. |

### Running commands

| Command | What it does |
|---|---|
| `gsa exec [-c pattern] -- <cmd>` | Run a command with credentials injected. `-c` selects a context. |
| `gsa console [pattern]` | Open provider web console in browser. |

### Configuration

| Command | What it does |
|---|---|
| `gsa config show` | Print full config. |
| `gsa config path` | Print config file path. |
| `gsa config get <key>` | Read a value (dot notation). |
| `gsa config set <key> <val>` | Write a value (dot notation). |

### Daemon (plumbing)

The daemon runs automatically. These commands are for troubleshooting.

| Command | What it does |
|---|---|
| `gsa serve` | Start credential daemon. |
| `gsa serve --foreground` | Run in foreground. |
| `gsa serve --install` | Install binary + create launch agent. |
| `gsa serve --uninstall` | Remove binary + launch agent. |

### AWS-specific

| Command | What it does |
|---|---|
| `gsa credential-process --context <id>` | `credential_process` JSON for `~/.aws/config`. |

### Other

| Command | What it does |
|---|---|
| `gsa shell-init <shell>` | Print shell integration (bash, zsh, fish). |
| `gsa upgrade` | Self-update. |

## Agent integration

AI agents can access credentials, but only for contexts you've explicitly approved.

```bash
gsa agent allow              # TUI: toggle which contexts agents can access
gsa agent allow --list       # show approved contexts
gsa agent allow --clear      # revoke all
gsa agent exec -- <cmd>      # run with agent-gated credentials
gsa agent mcp                # start MCP server
```

Default deny — nothing is accessible until you approve it.

### MCP server

```json
{
  "mcpServers": {
    "gsa": { "command": "gsa", "args": ["agent", "mcp"] }
  }
}
```

Tools: `run_with_credentials`, `list_contexts`.

### Wrapping other MCP servers

```json
{
  "mcpServers": {
    "aws-tools": { "command": "gsa", "args": ["agent", "exec", "--", "npx", "@aws/mcp-server"] }
  }
}
```

## Shell integration

```bash
eval "$(glrs-assume shell-init zsh)"
```

- `gsa use` and `gsa login` set context via env vars in the current shell
- Prompt shows `[aws:dev / developer]` (green for safe, red for dangerous)
- Per-shell isolation — each terminal has its own context
- Zero delay — reads an env var, no subprocess

## Configuration

`~/Library/Application Support/glrs-assume/config.toml` (macOS) or `~/.config/glrs-assume/config.toml` (Linux)

Upgrading from the old `gs-assume`? `gsa init` copies the legacy `gs-assume` config directory to this location automatically (it never deletes the old one).

```toml
[providers.aws]
enabled = true
start_url = "https://myorg.awsapps.com/start"
region = "us-east-1"

[providers.gcp]
enabled = true
```

### Context annotations

Add metadata to discovered contexts:

```toml
[[providers.aws.profiles]]
account_id = "111111111111"
role_name = "AdministratorAccess"
alias = "prod/admin"
tags = ["production", "dangerous"]
color = "red"
confirm = true
```

- `alias` — display name override, used in fuzzy matching
- `tags` — searchable, shown in `gsa contexts`
- `color` — prompt color (`red` for dangerous contexts)
- `confirm` — require confirmation before switching

### Team config

`glrs-assume.team.toml` in repo root. Merges with user config. User wins on conflicts.

## Security

- AES-256-GCM encrypted credential storage
- Daemon serves over localhost only
- All token files `0600`
- Agent access gated by allowlist (default deny)
- Operations audit-logged

## Platforms

macOS arm64, macOS x64, Linux x64, Linux arm64.
