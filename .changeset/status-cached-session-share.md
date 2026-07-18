---
"@glrs-dev/aj": patch
---

Status line: the `cached` stat now accumulates cache-read tokens across the session and shows their share of cumulative input (`in`), instead of the latest request's share of its own input — it measures how caching is working across the whole session.
