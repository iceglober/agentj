---
"@glrs-dev/aj": minor
---

MCP capabilities can now reach subagents and background build jobs, per-server and opt-in. HTTP servers may declare `inherit: "shared"` — children get a read-only view of the primary connection's catalog (they call tools but can never reload, close, or refresh it) — and stdio servers may declare `inherit: "isolated"` — each child gets its own server process rooted at its worktree, closed deterministically when the child finishes, with cleanup on partial startup. The default stays primary-only, and children's MCP calls ride the existing `permissions.mcp` policy with asks labeled by the requesting subagent or job.
