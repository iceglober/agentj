---
"@glrs-dev/aj": patch
---

Reflection display: wrap the dim block with a hanging indent, and show the pre_turn reflection.

- The dim reflection block now word-wraps to the terminal width, keeping each line's two-space indent on its wrapped continuations — so it reads cleanly in a narrow split pane instead of relying on terminal soft-wrap that dropped the indent.
- pre_turn reflections are now visible: a first-class `reflection` event renders the self-reflection dim between the user's question and the plan (question → reflection → plan), matching how post_turn shows it before the continuation.
