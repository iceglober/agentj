# Autopilot

Unattended [agent](/harness/agents) execution. Two modes.

## `glrs loop` — raw prompt

```bash
glrs loop "implement the auth middleware"
```

Sends your prompt to [`prime`](/harness/agents) each iteration until done.

### Safety limits

| Limit | Default |
|-------|---------|
| Max iterations | 50 |
| Wall-clock time | 4 hours |
| Zero-progress streak | 3 iterations |
| Kill switch | `.agent/autopilot-disable` |

Uses `autopilot-prime` — identical to `prime` but can't ask questions (no user present).

## `glrs autopilot` — structured orchestrator

Three phases: scope → plan → execute with self-assessment.

```bash
glrs autopilot --plan docs/plans/my-feature/
```

## When to use which

- **`glrs loop`** — single task, trust the agent to figure out the approach
- **`glrs autopilot`** — complex multi-phase work, structured planning before execution
- **Interactive** — you want to stay in the loop and use [commands](/harness/commands) directly
