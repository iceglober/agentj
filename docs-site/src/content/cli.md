# CLI reference

Every subcommand, argument, and flag — the same definitions `glorious --help` prints. `aj` is a short alias for `glorious`.

## `glorious`

Open an interactive chat session in the current repo (plan mode).

- `--continue` — reopen the newest session for this project
- `--resume <id>` — reopen a specific session

## `glorious run <task>`

Run one task non-interactively and exit.

- `<task>` — the task to run
- `--plan` — plan only: read-only tools, no edits
- `--allow-all` — resolve permission asks to allow (default: deny with a notice)

## `glorious config <set|get|delete> <key> [value]`

Inspect or update configuration. See [config](/config).

- `set <key> [value]` — `--secret` reads from masked input and stores in the OS keychain
- `get <key>` — read a value
- `delete <key>` — `--secret` removes a keychain secret

## `glorious update`

Update the installed CLI.

- `--channel <next|latest>` — release channel to install

## `glorious eval`

Run the eval harness (`eval`, `eval report`, `eval selfcheck`) — for contributors validating model behavior.
