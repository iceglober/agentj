---
"@glrs-dev/glorious": minor
---

`glorious config` now opens a full-screen, keyboard-driven config TUI — Models, the Trust access-control list, Providers, and MCP servers — instead of the drill-down menu (which remains a fallback). The full-screen OpenTUI chat renderer is also now the default; opt back to the lighter live-region renderer with `tui.renderer: ansi` (or `GLORIOUS_TUI=ansi` for one session).
