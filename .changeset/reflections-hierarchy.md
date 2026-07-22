---
"@glrs-dev/aj": patch
---

Reflections: group and dim the review receipt, bold the revised plan, and drop the dead refinePlan path.

- The reflection block now reads as quiet metadata — a dimmed `Reflections · <model>` header with two-space-indented `✓`/`✗` review lines — set clearly apart from the answer.
- The revised plan gets a bold, underlined `Revised plan` heading (the reviser is asked for a `# Revised plan` markdown heading, styled by the transcript renderer).
- Remove the legacy `refinePlan` dependency, which was wired nowhere in production and survived only through its own tests; its coverage moves to the live `reflectPlan` path.
