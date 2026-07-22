---
"@glrs-dev/aj": minor
---

Add an opt-in full-screen OpenTUI chat interface (`AGENTJ_TUI=opentui`). OpenTUI owns the whole alternate screen: the transcript is a sticky-bottom scroll region, the composer is a native text input that owns its own cursor, and modals are focused select/input overlays — so cursor and layout are handled by the framework rather than computed by hand. The default ANSI interface is unchanged. This replaces the earlier split-footer spike, whose divided ownership of the cursor could not be made reliable.
