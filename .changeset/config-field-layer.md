---
"@glrs-dev/aj": minor
---

Editing a list-valued config key no longer means typing raw JSON. `/config set agent.llm.tiers` (and any array key) now opens a guided list editor — add, edit, delete, and reorder items (order matters for the model ladder) — instead of asking for `["a","b"]`. Under the hood a new schema-field layer reads each config key's type straight from the zod schema, the groundwork for onboarding and a full config screen.
