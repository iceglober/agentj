# AgentJ cost dashboard

`cost-dashboard.json` is a Grafana dashboard generated from `evalPrices` in
`core/lib/eval/config.ts`. Do not edit the JSON directly; regenerate it after a
price change:

```sh
bun core/lib/metrics/dashboard/generate.ts
```

Import `generated/cost-dashboard.json` into Grafana and select (or change in
the JSON) the Prometheus datasource UID `prometheus`. The dashboard assumes an
OTLP-to-Prometheus pipeline that converts dots to underscores, appends the
`tokens` unit, and appends `_total` to counters. For example,
`agentj.llm.tokens.cache_read` becomes
`agentj_llm_tokens_cache_read_tokens_total`.

The throughput panel splits no-cache, cache-read, cache-write, and output
tokens by model. The cost panel applies each configured model's input price to
the three input splits and its output price to output tokens. Cache splits use
the configured input price because `evalPrices` deliberately supplies only
`in` and `out` prices.

The long-context panel uses
`agentj_llm_tokens_input_long_context_tokens_total`, emitted only when a
request has more than 272,000 input tokens. It is a synthetic two-times-input
price line for Azure's long-context tier; runtime telemetry remains free of USD
values.
