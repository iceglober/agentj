import { describe, expect, test } from "bun:test";
import { costOf, familyOf, TIER_MODELS } from "../src/agent/models.ts";

describe("model family + pricing", () => {
  test("maps ids to families, unknown → sonnet", () => {
    expect(familyOf("claude-opus-4-8")).toBe("opus");
    expect(familyOf("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(familyOf("claude-sonnet-4-6")).toBe("sonnet");
    expect(familyOf("something-weird")).toBe("sonnet");
  });

  test("costOf uses per-family per-1M pricing", () => {
    // sonnet: $3/M in, $15/M out → 1M in + 1M out = 3 + 15
    expect(costOf("claude-sonnet-4-6", { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(18);
    // opus: $5/M in, $25/M out
    expect(costOf("claude-opus-4-8", { promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(5);
    // haiku: $1/M in, $5/M out
    expect(costOf("claude-haiku-4-5-20251001", { promptTokens: 0, completionTokens: 1_000_000 })).toBeCloseTo(5);
  });

  test("every tier resolves to a model id", () => {
    expect(TIER_MODELS.deep).toContain("opus");
    expect(TIER_MODELS.mid).toContain("sonnet");
    expect(TIER_MODELS.fast).toContain("haiku");
    expect(TIER_MODELS.cheap).toContain("haiku");
  });
});
