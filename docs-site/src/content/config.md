# Configuration

All config lives in `~/.config/opencode/opencode.json`. Your values always win over plugin defaults.

## Model overrides

Override by tier or by [agent](/harness/agents):

```json
{
  "harness": {
    "models": {
      "deep": ["bedrock/claude-opus-4"],
      "mid": ["bedrock/claude-sonnet-4"],
      "fast": ["bedrock/claude-haiku-4"],
      "prime": ["my-custom-model"]
    }
  }
}
```

**Precedence:** per-agent > tier > plugin default. Direct `agent.<name>.model` in opencode.json wins over all.

## Per-agent overrides

```json
{
  "agent": {
    "prime": { "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

See the [agents reference](/harness/agents) for the full list of agent names and their default tiers.

## MCP servers

Three enabled by default, two opt-in:

| Server | Default | Backend |
|--------|---------|---------|
| serena | enabled | AST code intelligence via `uvx` |
| memory | enabled | Per-repo JSON memory via `npx` |
| git | enabled | Structured blame/log via `uvx` |
| playwright | disabled | Browser automation via `npx` |
| linear | disabled | Linear issue tracker via `npx` |

Enable in opencode.json:

```json
{
  "mcp": {
    "playwright": { "enabled": true },
    "linear": { "enabled": true }
  }
}
```

After enabling playwright:

```bash
npx playwright install chromium
```

## Environment variables

| Variable | Effect |
|----------|--------|
| `HARNESS_OPENCODE_UPDATE_CHECK=0` | Disable daily npm version check |
| `HARNESS_OPENCODE_PERM_DEBUG=1` | Write permission snapshots to `~/.local/state/harness-opencode/perm-debug.json` |

## Diagnostics

```bash
glrs harness doctor
```
