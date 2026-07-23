# Agent Skills

[agentskills.io](https://agentskills.io) format. A `SKILL.md` in a directory becomes model-activatable and a slash command.

## Location

- Project: `.glorious/skills/<name>/SKILL.md`
- Global: `~/.config/glorious/skills/<name>/SKILL.md`

Project wins name collisions.

## Activation

Name and description are injected into the system prompt; the model reads the body when a task matches. `/<name> <args>` runs the body as a turn, substituting `$ARGUMENTS`.

## Frontmatter

```markdown
---
name: ship
description: Ship finished work — changeset, PR, and merge.
user-invocable: true        # false → model-only
metadata:
  glorious-mode: build      # switch mode on invocation
---

Steps the agent follows…
```

Malformed skills surface as startup notices.
