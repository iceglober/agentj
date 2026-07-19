---
"@glrs-dev/aj": patch
---

Fixes a blank gap that appeared when a tall live region shrank right before a transcript line was written — most visibly, submitting a slash command left a band of empty rows (the height of the dismissed completion menu) between the last reply and the command's output. The transcript writer no longer scrolls by the previous paint's height; it lands each line on the bottom row and lets the next repaint reserve exactly the current live region, so the padding can't go stale.
