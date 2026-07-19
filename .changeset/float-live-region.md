---
"@glrs-dev/aj": patch
---

Fixes the unpredictable blank rows in the chat transcript at the source. The live region (editor, progress, status) was glued to the terminal's bottom by hand-tracked scroll bookkeeping; because that region changes height on every event mid-turn (a tool row appears, the thinking line toggles), the bookkeeping drifted from the real terminal state and deposited a variable band of blank rows — the height of the region at that instant — between transcript lines. The region now floats directly beneath the transcript using the terminal's own scrolling, with no scroll state to desync, so transcript lines always sit one row apart. When the transcript is short the editor rests just under the last line rather than at the very bottom of the window.
