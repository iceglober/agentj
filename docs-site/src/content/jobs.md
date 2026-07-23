# Background jobs

## Start one

Prefix a message with **`&`**:

```
& run the full test suite and report failures
```

Jobs run in their own worktree (build) or read-only (plan), and report into the transcript and the next turn.

## Agent-started

The agent detaches waits (CI, review, deploy) with `run_background_job`. A job can carry a renewable soft timeout: at the deadline the agent inspects the job's activity and extends or aborts it while the job keeps running. The `running-background-work` skill covers this.

## Manage

- `/jobs` — list
- `/jobs abort <id>` — stop one
