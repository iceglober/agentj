---
"@glrs-dev/aj": patch
---

A turn that ends without producing anything no longer looks like a freeze. When the model returns no text and ran no tools, the transcript now says so instead of silently returning to the prompt. Turn errors render in red, and a provider content-filter rejection — which can fire intermittently on the same conversation — gets an explicit hint to retry or start a fresh session rather than resuming the one that keeps tripping the filter.
