import { describe, expect, test } from "bun:test";
import { configHash, runConfigSchema, usdCost } from "./config";

const base = () =>
  runConfigSchema.parse({
    id: "sol",
    agent: { llm: { model: "gpt-5.6-sol" } },
  });

describe("configHash", () => {
  test("stable under input key reordering", () => {
    const a = runConfigSchema.parse({
      id: "x",
      agent: { name: "agentj", role: "primary", llm: { model: "m", provider: "azure" } },
    });
    const b = runConfigSchema.parse({
      id: "x",
      agent: { llm: { provider: "azure", model: "m" }, role: "primary", name: "agentj" },
    });
    expect(configHash(a)).toBe(configHash(b));
  });

  test("id is excluded from the hash", () => {
    const a = runConfigSchema.parse({ id: "sol", agent: { llm: { model: "m" } } });
    const b = runConfigSchema.parse({ id: "SOMETHING-ELSE", agent: { llm: { model: "m" } } });
    expect(configHash(a)).toBe(configHash(b));
  });

  test("a flag change moves the hash", () => {
    const off = base();
    const on = runConfigSchema.parse({
      id: "sol",
      agent: { llm: { model: "gpt-5.6-sol" }, prompt: { flags: { planning: true } } },
    });
    expect(configHash(off)).not.toBe(configHash(on));
  });

  test("edit mode change moves the hash", () => {
    const batch = base();
    const exact = runConfigSchema.parse({
      id: "sol",
      agent: { llm: { model: "gpt-5.6-sol" }, tools: { edit: { mode: "exact" } } },
    });
    expect(configHash(batch)).not.toBe(configHash(exact));
  });

  test("identical agent → identical hash across parses", () => {
    expect(configHash(base())).toBe(configHash(base()));
  });
});

describe("usdCost", () => {
  const prices = { "gpt-5.6-sol": { in: 1.25, out: 10 } };

  test("known model → priced", () => {
    // 1_000_000 in @1.25 + 500_000 out @10 = 1.25 + 5 = 6.25
    expect(usdCost(prices, "gpt-5.6-sol", 1_000_000, 500_000)).toBeCloseTo(6.25, 9);
  });

  test("unknown model → null", () => {
    expect(usdCost(prices, "deepseek-v4-pro", 1000, 1000)).toBeNull();
  });
});
