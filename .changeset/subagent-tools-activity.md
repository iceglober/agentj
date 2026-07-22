---
"@glrs-dev/aj": minor
---

Agentj can now delegate one independent task with `run_one_subagent` or coordinate several with `run_subagents`, making small delegation as easy as sending a prompt while retaining DAG support for larger work. The interactive chat stays quiet for tool calls that finish within 250ms, avoiding flicker in the live progress region; longer-running calls appear there while they run. Each finished tool then streams into the transcript as its own `✓ <tool> <detail> <duration>` line, and `/activity` shows the completed tool history when you want it.
