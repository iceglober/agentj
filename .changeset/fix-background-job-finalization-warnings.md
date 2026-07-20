---
"@glrs-dev/aj": patch
---

Background build jobs that finish their work but cannot remove a child worktree now complete with a cleanup warning instead of being reported as failed. For example, a job that merges a pull request and then hits a worktree cleanup error reports `done`, shows the exact warning, and preserves its recovery branch when needed.
