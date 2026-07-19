---
"@glrs-dev/aj": patch
---

The blank gap between the transcript and the editor no longer grows with the size of what was printed. The bottom-pinned live region padded each transcript write with newlines proportional to the block's own height, so a long reply or a tall progress block left a correspondingly tall band of empty rows above the editor. Writes now land tight against the pinned live region — placed exactly above it when they fit, and scrolled by a fixed amount (the live region's height) when they overflow — regardless of how many lines they contain.
