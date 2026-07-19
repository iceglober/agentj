---
"@glrs-dev/aj": patch
---

Auto-update now revalidates its check cache in the background. A launch inside the 24-hour check window still starts instantly off the cached answer, but the registry is re-queried behind the scenes and the cache rewritten — so a release published minutes after your last launch is picked up on the next one instead of up to a day later. Especially noticeable on the `next` channel, where publish-then-immediately-use is the normal rhythm.
