---
"@glrs-dev/aj": patch
---

Two resilience fixes for failed model requests. A request that dies on a transient error — our 30-minute deadline firing or the connection dropping — is now retried up to twice (10-minute deadline on retries, short backoff, caller aborts always win and are never retried); the retry re-sends exactly one HTTP request, never re-running tools. And when a turn still fails, the next turn now carries a notice with the error and the original request text, so "try again" actually retries instead of the model asking what you meant.
