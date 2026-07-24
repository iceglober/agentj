---
"@glrs-dev/glorious": minor
---

Replace the permission model with a default-deny access-control list. `permissions` is now `{ uncaged, rules }`: a map of idiomatic tool-call patterns to `allow`/`ask`/`deny`, where anything unmatched is denied. Patterns are the tool-call forms themselves — `bash(pnpm *)`, `edit`, `web`, and canonical MCP ids like `mcp_linear_get_issue` (or `mcp_linear_*`; the `mcp__` form is accepted as an alias) — with deny beating allow beating ask. A single `uncaged` flag opens everything. Repository reads/searches remain ungated. The shipped starter policy keeps out-of-the-box behavior equivalent to the old edit=allow / web=allow / bash=ask / mcp=ask defaults, fully overridable per project/machine.
