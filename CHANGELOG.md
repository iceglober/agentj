# @glrs-dev/glorious

## 0.1.0-next.0

### Minor Changes

- 62f6524: `glorious config` now opens a full-screen, keyboard-driven config TUI — Models, the Trust access-control list, Providers, and MCP servers — instead of the drill-down menu (which remains a fallback). The full-screen OpenTUI chat renderer is also now the default; opt back to the lighter live-region renderer with `tui.renderer: ansi` (or `GLORIOUS_TUI=ansi` for one session).
- 1aa4be0: Initial release of glorious — a terminal coding agent, and the flagship of the @glrs-dev ecosystem. (Formerly published as `@glrs-dev/aj`.)
- 62f6524: Replace the permission model with a default-deny access-control list. `permissions` is now `{ uncaged, rules }`: a map of idiomatic tool-call patterns to `allow`/`ask`/`deny`, where anything unmatched is denied. Patterns are the tool-call forms themselves — `bash(pnpm *)`, `edit`, `web`, and canonical MCP ids like `mcp_linear_get_issue` (or `mcp_linear_*`; the `mcp__` form is accepted as an alias) — with deny beating allow beating ask. A single `uncaged` flag opens everything. Repository reads/searches remain ungated. The shipped starter policy keeps out-of-the-box behavior equivalent to the old edit=allow / web=allow / bash=ask / mcp=ask defaults, fully overridable per project/machine.
- 62f6524: Add a clean plan→build handoff, per-role model variants, and layered config:

  - **Plan → build handoff.** `/build` now approves the plan and starts the builder on a fresh model context seeded with just the task and the approved plan (not the planner's transcript), then tells it to verify and correct the plan as it goes. Iterate on the plan in plan mode, then `/build` to implement.
  - **Per-role model variant.** Choose the reasoning effort (none/minimal/low/medium/high/xhigh/max) for the plan and build tiers in the config TUI; it's sent to the model at generation time. An unset tier uses the model profile's default.
  - **Layered config with provenance.** Config resolves across global → project → local layers; the TUI and CLI can target any layer (`--scope`, or the scope selector) and show which layer each value comes from.
  - Bare `/config` opens the interactive TUI in-chat, and edits apply to the running session on close.
