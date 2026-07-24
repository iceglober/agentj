---
"@glrs-dev/glorious": minor
---

Add a clean plan→build handoff, per-role model variants, and layered config:

- **Plan → build handoff.** `/build` now approves the plan and starts the builder on a fresh model context seeded with just the task and the approved plan (not the planner's transcript), then tells it to verify and correct the plan as it goes. Iterate on the plan in plan mode, then `/build` to implement.
- **Per-role model variant.** Choose the reasoning effort (none/minimal/low/medium/high/xhigh/max) for the plan and build tiers in the config TUI; it's sent to the model at generation time. An unset tier uses the model profile's default.
- **Layered config with provenance.** Config resolves across global → project → local layers; the TUI and CLI can target any layer (`--scope`, or the scope selector) and show which layer each value comes from.
- Bare `/config` opens the interactive TUI in-chat, and edits apply to the running session on close.
