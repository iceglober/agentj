# Built-in tools

The tools the agent uses to do work. Read and search tools are always available; mutating tools are build-mode only and [permission](/permissions)-gated.

## Files & shell

- **read / search** — read files and search the repo, ripgrep-powered. Never gated.
- **edit** — apply file changes. Strategy set by `agent.tools.edit.mode`: `exact`, `batch` (default), or `hash`.
- **bash** — run commands on the host, gated by `permissions.bash`.

## Web research

- **web_search** — search the public web through Exa's anonymous endpoint. No API key and no model-provider web feature required.
- **web_fetch** — fetch a specific public HTTP(S) URL and return Markdown/text.

Both work in plan and build modes, including research workers and jobs. Results are labeled **untrusted** — reference material, not instructions. Fetching blocks private, loopback, link-local, and reserved addresses, follows bounded redirects, and caps time and response size.

## Orchestration

- **run_subagents** — parallel task DAG. See [subagents](/subagents).
- **run_background_job** — detach a wait or long task. See [jobs](/jobs).
- **update_todos** — maintain the session todo list. See [sessions](/sessions).

## Output limits

Tool output returned to the model is capped by `agent.tools.maxOutputChars` (default 30k); over-cap output spills to a session file so nothing is lost.
