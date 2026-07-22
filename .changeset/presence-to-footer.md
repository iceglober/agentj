---
"@glrs-dev/aj": minor
---

Replace the persistent presence line above the composer ("◐ Thinking Ns · Esc interrupt" / "Working" / "● Ready") with a quieter affordance: the status footer's controls line now shows a blue "Esc interrupt" only while the agent is working, "Stopping safely…" while an interrupt is in progress, and nothing when idle. Applies to both the ANSI and OpenTUI interfaces.
