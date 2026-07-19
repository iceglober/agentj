import { describe, expect, test } from "bun:test";
import { accumulateCostRows, formatCostReport, type UsageRecord } from "./cost";

const record = (
  model: string,
  usage: Partial<UsageRecord["usage"]> & Pick<UsageRecord["usage"], "inputTokens" | "outputTokens">,
): UsageRecord => ({
  type: "usage",
  provider: "azure",
  model,
  ts: "t",
  usage: { longContextRequests: 0, ...usage },
});

const prices = { "gpt-5.6-sol": { in: 1.25, out: 10 } };

describe("accumulateCostRows", () => {
  test("groups by provider/model, sums splits, prices only mapped models", () => {
    const rows = accumulateCostRows(
      [
        record("gpt-5.6-sol", { inputTokens: 1_000_000, outputTokens: 100_000 }),
        record("gpt-5.6-sol", {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadInputTokens: 800_000,
          longContextRequests: 2,
        }),
        record("gpt-5.6-terra", { inputTokens: 10, outputTokens: 1 }),
      ],
      prices,
    );
    expect(rows).toHaveLength(2);
    const sol = rows.find((row) => row.model === "gpt-5.6-sol");
    expect(sol).toMatchObject({
      inputTokens: 2_000_000,
      cacheReadInputTokens: 800_000,
      outputTokens: 200_000,
      longContextRequests: 2,
    });
    // 2 Mtok in at $1.25 + 0.2 Mtok out at $10.
    expect(sol?.usd).toBeCloseTo(2 * 1.25 + 0.2 * 10, 6);
    expect(rows.find((row) => row.model === "gpt-5.6-terra")?.usd).toBeNull();
  });
});

describe("formatCostReport", () => {
  test("empty ledger states so plainly", () => {
    expect(formatCostReport([], prices)).toBe("No foreground-turn usage recorded yet.");
  });

  test("shows splits, long-context count, $ n/a for unpriced, and the cache note", () => {
    const report = formatCostReport(
      [
        record("gpt-5.6-sol", {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadInputTokens: 400_000,
          cacheWriteInputTokens: 50_000,
          longContextRequests: 3,
        }),
        record("gpt-5.6-terra", { inputTokens: 10, outputTokens: 1 }),
      ],
      prices,
    );
    expect(report).toContain("azure/gpt-5.6-sol | 1,000,000 (600,000 / 400,000 / 50,000)");
    expect(report).toContain("| 3 |");
    expect(report).toContain("azure/gpt-5.6-terra");
    expect(report).toContain("$ n/a");
    expect(report).toContain("$2.2500");
    expect(report).toContain("Cache reads are priced at the input rate.");
    // An unpriced model makes the grand total unknowable.
    expect(report.split("\n").at(-2)).toContain("$ n/a");
  });

  test("fully priced ledger totals in USD without the cache note", () => {
    const report = formatCostReport(
      [record("gpt-5.6-sol", { inputTokens: 2_000_000, outputTokens: 0 })],
      prices,
    );
    expect(report.split("\n").at(-1)).toContain("$2.5000");
    expect(report).not.toContain("Cache reads");
  });
});
