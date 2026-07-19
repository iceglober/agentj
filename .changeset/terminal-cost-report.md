---
"@glrs-dev/aj": minor
---

Terminal-native cost reporting replaces the briefly-committed Grafana dashboard (which assumed an OTLP→Prometheus pipeline most installs don't run). Each foreground turn now persists a usage record to the session log — provider/model, input tokens with cache-read/cache-write splits, output tokens, and a count of requests past Azure's 272k long-context tier — and the new `/cost` command prices the session (including resumed history) per model from the `eval.prices` $/Mtok map, showing `$ n/a` for unpriced models. Runtime metrics stay USD-free; the long-context OTel counter from the dashboard iteration is removed along with the dashboard.
