# CLI

`@glrs-dev/cli` — one binary, five subcommands.

```bash
npm i -g @glrs-dev/cli
```

Requires [Bun](https://bun.sh) ≥ 1.2.0 on PATH.

## `glrs harness`

Plugin management for the [OpenCode agent harness](/harness).

```bash
glrs harness install       # register in opencode.json
glrs harness configure     # interactive configuration
glrs harness doctor        # check installation health
glrs harness uninstall     # remove from opencode.json
```

See [configuration](/harness/config) for what the harness configures.

## `glrs wt`

Worktree management.

```bash
glrs wt new                # create worktree (auto-named)
glrs wt list               # list all worktrees
glrs wt switch             # interactive picker
glrs wt delete             # remove worktrees
glrs wt cleanup            # delete merged/stale
```

Bare `glrs wt` in a TTY drops into the interactive picker.

## `glrs autopilot`

Structured scope → plan → execute orchestrator. See [autopilot](/autopilot).

```bash
glrs autopilot --plan docs/plans/my-feature/
```

## `glrs loop`

Raw prompt loop. Runs [`prime`](/harness/agents) until done or budget hit. See [autopilot](/autopilot).

```bash
glrs loop "implement feature X"
```

## `glrs upgrade`

Self-update. Also runs automatically on every CLI invocation (rate-limited to hourly).
