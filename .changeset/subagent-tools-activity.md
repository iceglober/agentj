---
"@glrs-dev/aj": minor
---

Agentj can now delegate one independent task with `run_one_subagent` or coordinate several with `run_subagents`, making small delegation as easy as sending a prompt while retaining DAG support for larger work. The interactive chat stays quiet for tool calls that finish within 250ms, avoiding flicker; longer-running calls appear in the live progress region. It still prints one completion receipt such as `✓ 3 tools · 2.1s · /activity for details`, and `/activity` shows the completed tool history when you want it.
