---
"@glrs-dev/aj": patch
---

Esc now actually kills a running bash tool call. The turn's abort signal is threaded through the execution-environment port and across the vendor bash-tool boundary, and the host adapter kills the command's whole process group (SIGTERM, then SIGKILL) — previously the abort only cancelled the model request while the command ran to completion (up to the 10-minute timeout). Timeouts also kill the full process group now, so a compound command's child can no longer hold the tool call open after its parent bash is killed.
