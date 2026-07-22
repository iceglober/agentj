---
"@glrs-dev/aj": patch
---

Copy a highlighted selection to the system clipboard in the OpenTUI interface. OpenTUI draws the highlight but never wrote it anywhere, and macOS Cmd+C is a terminal shortcut that never reaches the app, so selections were uncopyable. The selection is now pushed to the clipboard over OSC 52 as it is made (terminal OSC 52 support required).
