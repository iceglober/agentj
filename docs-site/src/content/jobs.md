# Background jobs

Anything that would otherwise block the conversation — waiting on CI, a review, a deploy — runs as a background job instead.

## Start one

Prefix a message with **`&`**:

```
& run the full test suite and report failures
```

When `&` is the first editor character the editor turns yellow and shows `BACKGROUND JOB`. Jobs run in their own worktree (build) or read-only (plan), never race your checkout, and report into the transcript and the next turn.

## The agent starts them too

Asked to "wait for CI, then fix what breaks," the agent detaches the wait with `run_background_job` rather than sleep-blocking the turn. A job can carry a renewable **soft timeout**: at the deadline the agent is pinged, inspects the job's recent activity, and either extends the deadline or aborts a stuck job — the job keeps running throughout. The bundled `running-background-work` skill guides this for waits, reviews, releases, deploys, and delayed merges.

## Manage them

- `/jobs` — list background jobs
- `/jobs abort <id>` — stop one
