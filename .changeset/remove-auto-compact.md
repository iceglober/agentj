---
"@glrs-dev/aj": patch
---

Remove auto-compaction. The `agent.context.onLimit` config no longer accepts `compact`; crossing the context soft limit always posts a wrap-up/delegate notice (`warn`). Auto-compaction flattened the full conversation into a single model-authored summary, which discarded out-of-band state (live background jobs, current plan/build mode) and left the model narrating a stale, authoritative-looking history. Deleting it also drops the delegate-tier compactor runtime and the `AgentRuntime.compact` / `Agent.compact` surface.
