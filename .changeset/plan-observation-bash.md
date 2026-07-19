---
"@glrs-dev/aj": minor
---

Plan-mode agents — the interactive plan chat, plan background jobs, and research subagents — now carry an observation-only `bash` tool, gated by the same `permissions.bash` policy as build mode (asks are labeled with the requesting job or subagent). Previously a plan job like "wait for checks on PR 62" failed immediately because plan agents had no way to run commands at all; now it can run `gh pr checks`, inspect git state, or run tests, while file edits remain build-only.
