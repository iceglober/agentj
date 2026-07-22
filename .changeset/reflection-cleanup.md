---
"@glrs-dev/aj": minor
---

Two reflection cleanups. Reflection reviews never dump JSON into the transcript anymore: each shows one short summary line, or just the review name when there's nothing readable to surface, capped so it fits a narrow split pane. And when reflections are going to revise a plan, the throwaway draft is held back — you see only the revised plan (the draft is replayed if reflections don't land).
