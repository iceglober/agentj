---
"@glrs-dev/aj": patch
---

Ctrl+V now tells you what happened instead of doing nothing. It attaches files copied in your file manager (Finder, etc.) as `@references`; previously, if the clipboard held no files — because you copied text, copied nothing, or the copy wasn't detected — the key silently did nothing, which was indistinguishable from a broken feature. It now shows a notice explaining what the key is for and that terminal paste (⌘V) is how you paste text, and any clipboard read error is surfaced rather than swallowed.
