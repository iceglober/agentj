import { expect, test } from "bun:test";
import { estimatedUsd, parseClaudeUsage, parseCodexUsage, parseOpenCodeUsage } from "./usage";

test("normalizes Claude model usage and reported cost", () => {
  expect(
    parseClaudeUsage(
      JSON.stringify({
        total_cost_usd: 0.2,
        modelUsage: {
          opus: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 4, costUSD: 0.2 },
        },
      }),
    ),
  ).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, reportedUsd: 0.2 });
});

test("sums OpenCode step usage and native cost", () => {
  const usage = parseOpenCodeUsage(
    [
      {
        type: "step_finish",
        part: { tokens: { input: 100, output: 20, cache: { read: 40 } }, cost: 0.01 },
      },
      {
        type: "step_finish",
        part: { tokens: { input: 200, output: 30, cache: { read: 150 } }, cost: 0.02 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  expect(usage).toEqual({
    inputTokens: 300,
    outputTokens: 50,
    cacheReadTokens: 190,
    reportedUsd: 0.03,
  });
});

test("uses the final Codex turn usage and prices cached input separately", () => {
  const usage = parseCodexUsage(
    [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100 } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 100 },
      }),
    ].join("\n"),
  );
  expect(usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 800, outputTokens: 100 });
  expect(estimatedUsd(usage, { input: 5, output: 30, cacheRead: 0.5 })).toBeCloseTo(0.0044);
});
