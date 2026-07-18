---
"@glrs-dev/aj": minor
---

The primary agent can now start background jobs itself with a `run_job` tool — the same detached runner behind `&`-prefixed input. Asked to "wait for CI and then fix failures" (or any task blocked on something external), it detaches the wait into a job instead of sleep-polling in the foreground turn; the job's outcome reports into the transcript and the next turn as before. Plan agents may only start read-only plan jobs, and one-shot `agentj run` sessions report jobs as unavailable rather than orphaning detached work.
