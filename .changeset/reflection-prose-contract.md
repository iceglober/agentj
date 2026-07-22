---
"@glrs-dev/aj": patch
---

Reflection workers now return first-person prose, not a completion-report JSON.

- Add a `REFLECT` prompt variant: reflection workers keep their read-only tools and multi-step, one-turn nature (so they actually investigate and challenge their input), but are asked for first-person prose — no report schema, no JSON, no plan rewrite. This suppresses the RESEARCH block, the SUBAGENT_CONTRACT schema (which is profile-on for nano and carried the same schema independently), and its status=done comms fallback.
- Reflection workers bypass the completion-grounding gate, which was overwriting a reflection with a `{"status":"blocked",…}` report whenever the prose tripped its deferred-work detector.
- Add an optional `agent.reflections.temperature` knob (higher = more divergent challenging). Note: reasoning models such as gpt-5.4-nano ignore temperature, so it is unset by default.
- Show the reflection prose with a clean ellipsis at 400 chars instead of a mid-sentence `[trunc N chars]` marker.
