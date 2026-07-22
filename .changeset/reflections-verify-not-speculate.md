---
"@glrs-dev/aj": patch
---

Reflections now verify with their tools and add depth, instead of making the answer retract true claims.

An audited session showed the reflection *degrading* accuracy: it raised unverified doubts ("I haven't checked whether MCP exists"), and the revision — told not to re-investigate — caved and deleted two real features (MCP support and true undo/redo). Fixed at all three prompt sites:

- The reflection worker must use its read-only tools to resolve doubts, never write "I haven't checked X", and report only what it verified — so it adds the depth a user would otherwise have to walk the agent through.
- The revision folds in what the reflection *verified*, but must not weaken or drop a claim just because a reflection was unsure.

Verified end-to-end on the same "what does agentj do" turn: the reflection now confirms MCP and undo/redo in the code, the revision keeps them and adds nuance (MCP is mode-dependent and per-server opt-in), and it makes only real corrections (no built-in browser automation).
