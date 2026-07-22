---
"@glrs-dev/aj": patch
---

Reflections are now the agent's own first-person self-reflection, not an external review or a plan rewrite.

- Reflection workers reflect in the first person ("I'm assuming X…") on their input — the task for pre_turn, the drafted plan for post_turn — in a few concrete sentences. They never write or rewrite a plan.
- The draft plan is shown immediately (the earlier draft-deferral is gone). After it, the reflection appears as a dim block, and the agent continues in the first person — tightening specific steps or noting the plan holds — instead of emitting a second "revised plan".
