## Command line

Every subcommand, argument, and flag — generated from the same definitions `glorious --help` prints.

:::details Show all commands and flags

### `glorious`

Interactive coding agent. Bare invocation opens a chat session; `run` executes one task.

- `--resume <str>` — Resume a chat session by id.
- `--continue` — Resume the newest chat session for this project.

### `glorious run <task>`

Run one task non-interactively and exit.

- `<task>` — Task to run.
- `--plan` — Plan only — read-only tools, no edits.
- `--allow-all` — Resolve permission asks to allow (default: deny with a notice).

### `glorious update`

Update the Glorious CLI.

- `--channel <value>` — Release channel to install.

### `glorious config set <key> [value]`

Set an Glorious configuration value.

- `<key>` — Public configuration key to set.
- `[value]` — Value to store for a normal configuration key.
- `--secret` — Read the value from masked input and store it in the keychain.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

### `glorious config get <key>`

Read an Glorious configuration value.

- `<key>` — Configuration key to read.

### `glorious config delete <key>`

Delete an Glorious configuration value.

- `<key>` — Public configuration key to delete.
- `--secret` — Delete a secret stored in the keychain.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

### `glorious config allow <pattern>`

Set a permission rule to allow (default-deny access control).

- `<pattern>` — Tool-call pattern: bash(pnpm *), edit, web, or mcp_<server>_<tool>.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

### `glorious config ask <pattern>`

Set a permission rule to ask (default-deny access control).

- `<pattern>` — Tool-call pattern: bash(pnpm *), edit, web, or mcp_<server>_<tool>.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

### `glorious config deny <pattern>`

Set a permission rule to deny (default-deny access control).

- `<pattern>` — Tool-call pattern: bash(pnpm *), edit, web, or mcp_<server>_<tool>.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

### `glorious config unrule <pattern>`

Remove a permission rule.

- `<pattern>` — The rule pattern to remove.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

### `glorious config uncaged <on|off>`

Allow every gated tool call, or restore default-deny.

- `<on|off>` — `on` opens every gated call; `off` restores the rules.
- `--scope <value>` — Layer to write: global (you, default), project (.glorious), or local (this machine).

:::
