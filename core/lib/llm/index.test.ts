import { describe, expect, test } from "bun:test";
import {
  llmConfigSchema,
  parseModelRef,
  resolveTier,
  resolveTierModel,
  resolveTierVariant,
} from ".";

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

  test("parseModelRef splits a known provider prefix; bare ids use the default", () => {
    expect(parseModelRef("azure/gpt-5.6-sol", "azure")).toEqual({
      provider: "azure",
      model: "gpt-5.6-sol",
    });
    expect(parseModelRef("openai/gpt-4o", "azure")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    // Unknown prefix (or a model id containing a slash) stays under the default.
    expect(parseModelRef("gpt-5.6-luna", "azure")).toEqual({
      provider: "azure",
      model: "gpt-5.6-luna",
    });
    expect(parseModelRef("some-vendor/thing", "azure")).toEqual({
      provider: "azure",
      model: "some-vendor/thing",
    });
    // openai-compatible keeps a slash-bearing model id intact after the prefix.
    expect(parseModelRef("openai-compatible/anthropic/claude", "azure")).toEqual({
      provider: "openai-compatible",
      model: "anthropic/claude",
    });
  });

  test("resolveTier gives each tier its own provider and model", () => {
    const llm = llmConfigSchema.parse({
      tiers: ["azure/gpt-5.6-sol", "vertex/gemini-2.0-flash"],
      modes: { plan: 0, build: 1 },
    });
    expect(resolveTier(llm, 0)).toEqual({ provider: "azure", model: "gpt-5.6-sol" });
    expect(resolveTier(llm, 1)).toEqual({ provider: "vertex", model: "gemini-2.0-flash" });
    // Empty ladder → the config's default provider/model.
    const bare = llmConfigSchema.parse({ provider: "openai", model: "gpt-4o" });
    expect(resolveTier(bare, 0)).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  test("per-tier variant overrides resolve by index, unset tiers stay undefined", () => {
    const llm = llmConfigSchema.parse({ tiers: ["a", "b"], variants: ["high", "low"] });
    expect(resolveTierVariant(llm, 0)).toBe("high");
    expect(resolveTierVariant(llm, 1)).toBe("low");
    // No variant recorded for a tier → undefined (caller uses the profile default).
    expect(resolveTierVariant(llmConfigSchema.parse({ tiers: ["a", "b"] }), 1)).toBeUndefined();
    expect(resolveTierVariant(llm, 5)).toBeUndefined();
  });

  test("variants are constrained to the accepted effort set", () => {
    expect(llmConfigSchema.parse({ variants: ["minimal", "xhigh", "max"] }).variants).toEqual([
      "minimal",
      "xhigh",
      "max",
    ]);
    expect(() => llmConfigSchema.parse({ variants: ["turbo"] })).toThrow();
  });

  test("ladder entries must be non-empty strings", () => {
    expect(() => llmConfigSchema.parse({ tiers: [""] })).toThrow();
  });
});
