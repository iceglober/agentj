---
"@glrs-dev/aj": patch
---

Long completion and guided-input lists now scroll with the selection instead of truncating at 7 rows. All list surfaces (slash completions, `/config set` paths, guided choices) render through one windowed-list primitive with `… ↑N/↓N more` overflow markers, so every item is reachable with the arrow keys.
