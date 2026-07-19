import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { evalPrices } from "../../eval/config";
import { generateCostDashboardJson } from "./generate";

const dashboardPath = new URL("./generated/cost-dashboard.json", import.meta.url);

describe("cost dashboard", () => {
  test("committed Grafana JSON is generated from eval prices", async () => {
    expect(await readFile(dashboardPath, "utf8")).toBe(generateCostDashboardJson());
  });

  test("prices every configured model and queries the exported Prometheus metric names", () => {
    const dashboard = generateCostDashboardJson();

    for (const model of Object.keys(evalPrices)) expect(dashboard).toContain(model);
    expect(dashboard).toContain("agentj_llm_tokens_cache_read_tokens_total");
    expect(dashboard).toContain("agentj_llm_tokens_cache_write_tokens_total");
    expect(dashboard).toContain("agentj_llm_tokens_no_cache_tokens_total");
    expect(dashboard).toContain("agentj_llm_tokens_input_long_context_tokens_total");
  });
});
