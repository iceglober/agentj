## Command line

Every subcommand, argument, and flag — generated from the same definitions `agentj --help` prints.

:::details Show all commands and flags

### `agentj`

Interactive coding agent. Bare invocation opens a chat session; `run` executes one task.

- `--resume <str>` — Resume a chat session by id.
- `--continue` — Resume the newest chat session for this project.

### `agentj run <task>`

Run one task non-interactively and exit.

- `<task>` — Task to run.
- `--plan` — Plan only — read-only tools, no edits.
- `--allow-all` — Resolve permission asks to allow (default: deny with a notice).

### `agentj update`

Update the AgentJ CLI.

- `--channel <value>` — Release channel to install.

### `agentj config set <key> [value]`

Set an AgentJ configuration value.

- `<key>` — Public configuration key to set.
- `[value]` — Value to store for a normal configuration key.
- `--secret` — Read the value from masked input and store it in the keychain.

### `agentj config get <key>`

Read an AgentJ configuration value.

- `<key>` — Configuration key to read.

### `agentj config delete <key>`

Delete an AgentJ configuration value.

- `<key>` — Public configuration key to delete.
- `--secret` — Delete a secret stored in the keychain.

:::
