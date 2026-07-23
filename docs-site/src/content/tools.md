# Built-in tools

Read and search are always available; mutating tools are build-mode only and [permission](/permissions)-gated.

## Files & shell

- **read / search** — ripgrep-powered.
- **edit** — strategy set by `agent.tools.edit.mode`: `exact`, `batch` (default), `hash`.
- **bash** — gated by `permissions.bash`.

## Web

- **web_search** — public web via Exa's anonymous endpoint. No API key.
- **web_fetch** — a public HTTP(S) URL as Markdown/text. Blocks private, loopback, link-local, and reserved addresses; bounded redirects, time, and size.

Results are labeled untrusted. Both work in plan and build.

## Orchestration

- **run_subagents** — [subagents](/subagents).
- **run_background_job** — [jobs](/jobs).
- **update_todos** — [sessions](/sessions).

## Output cap

`agent.tools.maxOutputChars` (default 30000); overflow spills to a session file.
