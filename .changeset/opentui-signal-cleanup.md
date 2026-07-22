---
"@glrs-dev/aj": patch
---

Restore the terminal when the OpenTUI interface is killed. A hard SIGTERM/SIGHUP (for example `bun run dev` being terminated) skipped the normal teardown, leaving the terminal in mouse-tracking and alternate-screen mode so it flooded the shell with mouse reports on every move or click. The OpenTUI screen now catches those signals, restores the terminal (mouse off, alt-screen exited, cursor shown), and re-raises so the process still exits.
