---
"@glrs-dev/aj": minor
---

Show the full tool-activity stream in the transcript again: each finished tool prints its own `✓ <tool> <detail> <duration>` line (with any nested subagent rows beneath it) as it completes, instead of collapsing the whole turn into a single `N tools · /activity for details` receipt. The `/activity` command still lists the session's completed tools.
