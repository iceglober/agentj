---
"@glrs-dev/aj": patch
---

`/clear` now starts a fresh chat context instead of only erasing terminal output. It removes prior conversation history and foreground cost data from the active and resumed session, clears the terminal, and keeps the selected mode and running background jobs.
