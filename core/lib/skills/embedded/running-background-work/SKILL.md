---
name: running-background-work
description: Run work that must continue after this turn, such as waiting for CI, releases, reviews, deploys, or delayed merges. Use when the user asks to wait, monitor, or continue after an external event.
user-invocable: false
---

# Running background work

Use `run_job` before saying that work is being monitored or will continue after
this turn. Report the returned job ID. Never sleep, poll, or wait in the
foreground.

Choose the job mode from the whole task:

- Use `plan` only when every later action is read-only, such as checking CI or
  reporting a review result.
- Use `build` when the task may merge, push, deploy, edit, fix a failure, or
  otherwise mutate anything after the external event.

Give the job enough context to finish independently: identifiers, the desired
outcome, what to check, and what action to take once ready. Set a soft timeout
when you can estimate the wait. When the job finishes, its notice is delivered
on a later turn; do not claim completion before then.
