import { expect, test } from "bun:test";
import { estimateMatrixCost } from "./pricing";

test("estimates every arm over the selected task count", () => {
  const price = { input: 1, output: 2, cacheRead: 0.1 };
  const result = estimateMatrixCost(
    {
      "glorious-luna": price,
      "codex-sol": price,
      "claude-opus-4.7": price,
      "claude-fable-5": price,
      "opencode-luna": price,
    },
    2,
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, reportedUsd: null },
  );
  expect(result.byArm["glorious-luna"]).toBe(6);
  expect(result.total).toBe(30);
});
