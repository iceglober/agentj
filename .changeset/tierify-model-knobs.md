---
"@glrs-dev/aj": minor
---

Model-picking config is now tier-first everywhere: `eval.judge.tier` routes the eval judge through the `llm.tiers` ladder (default: the frontier rung, falling back to the agent model when no ladder is configured — previously a hardcoded `gpt-5.6-sol`), and both `eval.judge.model` and `agent.tools.subagents.model` are deprecated escape hatches that still win over their tiers for back-compat. A provider or ladder swap no longer touches routing config.
