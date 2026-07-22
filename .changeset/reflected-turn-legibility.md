---
"@glrs-dev/aj": patch
---

Make a reflected plan turn legible: label the revision and stop it re-investigating.

A reflected plan turn has three phases (draft plan → reflection → revised take), and the transcript blurred them — two rounds of tool activity, the dim reflection prose running straight into the revision's tool rows, and no labels.

- The reflection is now its own dim block, and the revision is introduced by a dim `Revised · after reflection` label, so the phases read distinctly.
- The revision continues from the reflection's findings without re-opening files or re-running searches — the reflection workers already investigated — so there's no confusing second tool avalanche.
- The one-shot `run` renderer now prints reflection blocks too (the interactive TUI already did).
