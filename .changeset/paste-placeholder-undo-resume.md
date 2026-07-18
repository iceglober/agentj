---
"@glrs-dev/aj": patch
---

Large pastes collapse to a `[pasted content #N: X chars]` placeholder in the editor (expanded back on submit), and the live region is clamped to the terminal height — a paste taller than the window previously corrupted every repaint, duplicating the screen into scrollback. Resuming a session no longer fails with `cannot lock ref refs/agentj/undo/...`: the undo stack continues its ref counter from the previous run and keeps those snapshots undoable.
