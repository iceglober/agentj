import { describe, expect, test } from "bun:test";
import { configField } from "./fields";

describe("configField", () => {
  test("reports schema-backed field kinds, enum values, and defaults", () => {
    expect(configField("agent.context.onLimit")).toMatchObject({
      kind: "enum",
      enumValues: ["warn", "compact"],
    });
    expect(configField("agent.llm.tiers")).toMatchObject({ kind: "string-array" });
    expect(configField("agent.steps")).toMatchObject({ kind: "number", defaultValue: 100 });
    expect(configField("permissions.edit")).toMatchObject({ kind: "enum" });
    expect(configField("agent.tools.subagents.concurrency")).toMatchObject({ kind: "number" });
  });

  test("flags provider API keys as secret", () => {
    expect(configField("agent.llm.providers.azure.apiKey").secret).toBe(true);
    expect(configField("agent.steps").secret).toBeUndefined();
  });

  test("rejects a path that is not a real config key", () => {
    expect(() => configField("agent.not.a.real.key")).toThrow("Unknown configuration path");
  });

  test("carries the editorial description from the shared reference", () => {
    expect(configField("agent.steps").description).toContain("tool-loop ceiling");
  });
});
