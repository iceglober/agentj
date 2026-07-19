---
"@glrs-dev/aj": minor
---

Auto smart compact: set `agent.context.onLimit: "compact"` and when a foreground request's context crosses `agent.context.softLimit`, the session summarizes its history into a fresh continuation (via the subagent-tier model) at the end of the turn instead of only warning — the compacted state persists to the session log, so `--resume` picks it up for free. The default `"warn"` path now re-arms instead of firing once: after the first warning, it warns again each time context grows another tenth of the soft limit.
