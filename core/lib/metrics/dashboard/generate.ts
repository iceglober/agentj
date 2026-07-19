import { writeFile } from "node:fs/promises";
import { evalPrices } from "../../eval/config";

const dashboardPath = new URL("./generated/cost-dashboard.json", import.meta.url);
const prometheusDatasource = { type: "prometheus", uid: "prometheus" };

interface Target {
  expr: string;
  legendFormat: string;
  refId: string;
}

function modelSelector(model: string): string {
  return `{model=${JSON.stringify(model)}}`;
}

function panel(
  id: number,
  title: string,
  unit: string,
  targets: Target[],
): Record<string, unknown> {
  return {
    datasource: prometheusDatasource,
    fieldConfig: { defaults: { unit }, overrides: [] },
    gridPos: { h: 9, w: 12, x: id % 2 === 0 ? 12 : 0, y: Math.floor((id - 1) / 2) * 9 },
    id,
    options: { legend: { displayMode: "table", placement: "bottom", showLegend: true } },
    targets,
    title,
    type: "timeseries",
  };
}

/** Render the Grafana dashboard from the eval $/Mtok source of truth. */
export function generateCostDashboard(): Record<string, unknown> {
  const throughputTargets: Target[] = [];
  const costTargets: Target[] = [];
  const longContextTargets: Target[] = [];
  let refId = 0;

  for (const [model, price] of Object.entries(evalPrices).sort(([a], [b]) => a.localeCompare(b))) {
    const selector = modelSelector(model);
    for (const [kind, metric] of [
      ["no cache", "agentj_llm_tokens_no_cache_tokens_total"],
      ["cache read", "agentj_llm_tokens_cache_read_tokens_total"],
      ["cache write", "agentj_llm_tokens_cache_write_tokens_total"],
      ["output", "agentj_llm_tokens_output_tokens_total"],
    ] as const) {
      throughputTargets.push({
        expr: `sum(rate(${metric}${selector}[$__rate_interval]))`,
        legendFormat: `${model} ${kind}`,
        refId: String.fromCharCode(65 + refId++),
      });
    }

    const inputCost = [
      "agentj_llm_tokens_no_cache_tokens_total",
      "agentj_llm_tokens_cache_read_tokens_total",
      "agentj_llm_tokens_cache_write_tokens_total",
    ]
      .map((metric) => `sum(rate(${metric}${selector}[$__rate_interval])) * ${price.in} / 1000000`)
      .join(" + ");
    const outputCost = `sum(rate(agentj_llm_tokens_output_tokens_total${selector}[$__rate_interval])) * ${price.out} / 1000000`;
    costTargets.push({
      expr: `(${inputCost} + ${outputCost}) * 3600`,
      legendFormat: model,
      refId: String.fromCharCode(65 + costTargets.length),
    });
    longContextTargets.push({
      expr: `sum(rate(agentj_llm_tokens_input_long_context_tokens_total${selector}[$__rate_interval])) * ${price.in} * 2 / 1000000 * 3600`,
      legendFormat: `${model} 2x input tier`,
      refId: String.fromCharCode(65 + longContextTargets.length),
    });
  }

  return {
    annotations: { list: [] },
    editable: true,
    panels: [
      panel(1, "Token throughput by model", "ops", throughputTargets),
      panel(2, "Priced tokens by model", "currencyUSD", costTargets),
      panel(3, "Long-context input tier (>272k tokens)", "currencyUSD", longContextTargets),
    ],
    schemaVersion: 41,
    tags: ["agentj", "otel", "cost"],
    templating: { list: [] },
    time: { from: "now-6h", to: "now" },
    timezone: "browser",
    title: "AgentJ cost dashboard",
    uid: "agentj-cost",
    version: 1,
  };
}

export function generateCostDashboardJson(): string {
  return `${JSON.stringify(generateCostDashboard(), null, 2).replace(
    '"tags": [\n    "agentj",\n    "otel",\n    "cost"\n  ]',
    '"tags": ["agentj", "otel", "cost"]',
  )}\n`;
}

if (import.meta.main) await writeFile(dashboardPath, generateCostDashboardJson());
