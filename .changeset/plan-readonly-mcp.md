---
"@glrs-dev/aj": minor
---

Plan mode exposes MCP tools gated by the server's `readOnlyHint` annotation, and tool/resource mode filters default to `["*"]` — read-only MCP tools (e.g. Linear's `list_*`/`get_*`) now work in plan mode out of the box, while write tools stay build-only.
