---
"@glrs-dev/aj": minor
---

Plan mode can now run named, parallel reflections after it first drafts a plan. Configure `agent.reflections.prompts` with reviews such as an architecture check and a testing check; AgentJ shows their live progress, records a compact `Reflections: …` transcript marker, and uses their findings to produce one revised plan while retaining the original draft if reflection fails.
