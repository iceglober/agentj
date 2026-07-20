---
"@glrs-dev/aj": patch
---

Background build jobs now use unique, repository-scoped child worktrees and report setup or integration failures as failed instead of incorrectly reporting them as done. For example, a stale temporary worktree from another project no longer prevents `run_job` from starting.
