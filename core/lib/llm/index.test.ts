import { describe, expect, test } from "bun:test";
import { llmConfigSchema, resolveTierModel } from ".";

describe("llm tier ladder", () => {
  test("defaults: empty ladder, plan on frontier, build one rung down", () => {
    const llm = llmConfigSchema.parse({});
    expect(llm.model).toBe("gpt-5.6-luna");
    expect(llm.tiers).toEqual([]);
    expect(llm.modes.plan).toBe(0);
    expect(llm.modes.build).toBe(1);
  });

  test("empty ladder resolves every tier to the base model", () => {
    const llm = llmConfigSchema.parse({ model: "gpt-5.6-sol" });
    expect(resolveTierModel(llm, 0)).toBe("gpt-5.6-sol");
    expect(resolveTierModel(llm, 3)).toBe("gpt-5.6-sol");
  });

  test("tier indices resolve in ladder order", () => {
    const llm = llmConfigSchema.parse({
      tiers: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    });
    expect(resolveTierModel(llm, 0)).toBe("gpt-5.6-sol");
    expect(resolveTierModel(llm, 1)).toBe("gpt-5.6-terra");
    expect(resolveTierModel(llm, 2)).toBe("gpt-5.6-luna");
  });

  test("out-of-range tiers clamp to the cheapest rung, never throw", () => {
    const llm = llmConfigSchema.parse({ tiers: ["fable", "opus", "haiku"] });
    expect(resolveTierModel(llm, 9)).toBe("haiku");
    expect(resolveTierModel(llm, -1)).toBe("fable");
  });

  test("ladder entries must be non-empty strings", () => {
    expect(() => llmConfigSchema.parse({ tiers: [""] })).toThrow();
  });
});
