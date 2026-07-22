---
"@glrs-dev/aj": patch
---

Stop the composer cursor from flickering while the agent works, and make the busy VU meter animate fluidly. Each live-region repaint is now emitted as a single synchronized terminal update, so the erase-redraw-reposition applies atomically with no mid-frame cursor jump or tearing (terminals without the feature are unaffected). The meter animates on its own fast frame (~11fps) while the progress spinner and clocks stay on the calmer cadence.
