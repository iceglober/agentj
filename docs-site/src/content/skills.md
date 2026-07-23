# Agent Skills

Skills are reusable, model-activatable playbooks in the [agentskills.io](https://agentskills.io) format. Drop a `SKILL.md` in a directory and the agent can invoke it.

## Where they live

- Project: `.glorious/skills/<name>/SKILL.md`
- Global: `~/.config/glorious/skills/<name>/SKILL.md`

Project skills win name collisions.

## How they activate

Each skill's name and description are injected into the system prompt, so the model can read a skill's body and follow it when a task matches — progressive disclosure, not a wall of instructions. Every skill is **also** a slash command: `/<name> <args>` starts a turn with the skill body as the prompt, substituting `$ARGUMENTS`.

## Frontmatter

```markdown
---
name: ship
description: Ship finished work — changeset, PR, and merge.
user-invocable: true        # false → model-only, no slash command
metadata:
  glorious-mode: build      # switch to build mode on invocation
---

Steps the agent should follow…
```

Set `user-invocable: false` to keep a skill model-only. Malformed skills surface as startup notices without blocking the session.
