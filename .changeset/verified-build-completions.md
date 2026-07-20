---
"@glrs-dev/aj": patch
---

AgentJ now verifies a build-mode `done` report against tools it actually ran. For example, a response that claims tests passed without a matching successful bash command is retried once and then shown as an explicit failure instead of a completed task.
