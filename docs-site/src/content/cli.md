# CLI reference

Matches `glorious --help`.

## `glorious`

Interactive session (plan mode).

- `--continue` — newest session for this project
- `--resume <id>` — a specific session

## `glorious run <task>`

- `<task>`
- `--plan` — read-only, no edits
- `--allow-all` — resolve asks to allow (default: deny)

## `glorious config <set|get|delete> <key> [value]`

See [config](/config).

- `set <key> [value]` — `--secret` reads masked input into the keychain
- `get <key>`
- `delete <key>` — `--secret` removes a keychain secret
- `add|remove <key> <value>` — for array values

## `glorious config <allow|ask|deny|unrule|uncaged>`

Permission [ACL](/permissions) — idempotent.

- `allow|ask|deny <pattern>` — set a rule (`bash(pnpm *)`, `edit`, `web`, `mcp_linear_get_issue`)
- `unrule <pattern>` — remove a rule
- `uncaged on|off` — open everything, or restore default-deny

## `glorious update`

- `--channel <next|latest>`

## `glorious eval`

`eval`, `eval report`, `eval selfcheck`.
