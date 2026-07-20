---
"@glrs-dev/aj": minor
---

AgentJ now layers project configuration from `.aj/config.json` and `.aj/config.local.json` above canonical global configuration at `~/.config/aj/config.json`. Existing `~/.config/agentj/config.json` files remain a fallback until a canonical global config exists.
