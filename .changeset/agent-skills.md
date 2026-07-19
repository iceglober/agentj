---
"@glrs-dev/aj": minor
---

Agent Skills (the agentskills.io format) are now discovered from `.aj/skills/<name>/SKILL.md` in the project and `~/.config/agentj/skills/<name>/SKILL.md` globally (project wins name collisions). Each skill's name and description are injected into the system prompt so the model can activate one by reading its SKILL.md when a task matches (progressive disclosure), and every skill is also invocable directly as a `/name` slash command — `/<name> <args>` starts a turn with the skill body as the prompt, substituting `$ARGUMENTS` when the body uses it. agentj-specific behavior rides the spec's `metadata` map: `agentj-mode: build` switches mode on invocation, `agentj-model-invocation: disabled` keeps a skill out of the prompt listing. Malformed skills surface as startup notices without blocking the session.
