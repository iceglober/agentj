---
"@glrs-dev/aj": patch
---

No more dead space between the transcript and the editor. After a tall progress block (parallel tools, subagent fan-outs) collapsed, the bottom-pinned live region left a permanent blank band under the transcript — the reservation only ever grew, and every transcript line was re-padded to the high-water mark. Transcript writes now land at the top of the vacated band and reclaim it, scrolling only enough to keep the rows the live region actually paints.
