---
"@glrs-dev/aj": minor
---

Cost dashboard for the OTLP token metrics: `bun core/lib/metrics/dashboard/generate.ts` renders a Grafana dashboard (committed at `core/lib/metrics/dashboard/generated/cost-dashboard.json`, pinned up-to-date by a test) from the `evalPrices` $/Mtok source of truth — token throughput by model with cache splits, $ per hour by model, and a synthetic 2x-priced line for Azure long-context requests. Runtime metrics gain one content-free counter, `agentj.llm.tokens.input_long_context`, emitted only when a request exceeds 272k input tokens; runtime telemetry stays USD-free.
