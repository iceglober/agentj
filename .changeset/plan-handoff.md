---
"@glrs-dev/aj": patch
---

Plan mode now hands off in one gesture. A plan closes by naming the single most likely next action, so accepting collapses to pressing Tab or `/build` instead of restating what you obviously want. The stop rules also lean less on "should I?": when the conversation already implies the answer the agent states the assumption and acts (build) or names it in a line (plan) — while still asking before anything permission-gated, destructive, or outward-facing.
