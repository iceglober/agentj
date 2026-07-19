---
"@glrs-dev/aj": patch
---

Long model requests no longer die at five minutes. Bun's fetch imposes a hardcoded 300-second timeout when no signal is supplied, so a long reasoning request could kill a whole turn with "The operation timed out" (observed killing a one-shot `agentj run` mid-task). Azure model requests now always carry an explicit 30-minute deadline signal, composed with the turn's own abort signal so interrupts still win.
