---
"@glrs-dev/aj": minor
---

Background jobs gain renewable soft timeouts and live inspection. `run_job` accepts `softTimeoutMinutes`: if the job is still running at the deadline, the agent is pinged through the normal turn queue (hidden while queued, visible once its turn runs) while the job keeps running. A new `check_job` tool shows a job's status, elapsed time, recent tool calls, and result, and lets the agent renew the soft timeout for a healthy-but-slow job or abort a stuck one. In practice: the agent estimates a test run at 5–8 minutes, sets an 8-minute soft timeout, and on ping either finds the finished result or checks the job and extends the deadline.
