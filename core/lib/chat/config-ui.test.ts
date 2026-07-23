import { describe, expect, test } from "bun:test";
import { type ConfigUiPort, runConfigUi } from "./config-ui";
import type { GuidedInputOptions } from "./guided-input";

const scriptedPort = (script: {
  inputs?: (string | null)[];
  values?: Record<string, unknown>;
}): {
  port: ConfigUiPort;
  applied: { path: string; value: string }[];
  secrets: { path: string; value: string }[];
  prompts: GuidedInputOptions[];
} => {
  const inputs = [...(script.inputs ?? [])];
  const applied: { path: string; value: string }[] = [];
  const secrets: { path: string; value: string }[] = [];
  const prompts: GuidedInputOptions[] = [];
  const port: ConfigUiPort = {
    askInput: async (options) => {
      prompts.push(options);
      return inputs.length ? (inputs.shift() ?? null) : null;
    },
    read: async (path) => script.values?.[path],
    apply: async (path, value) => {
      applied.push({ path, value });
      return true;
    },
    applySecret: async (path, value) => {
      secrets.push({ path, value });
      return true;
    },
    note: () => {},
  };
  return { port, applied, secrets, prompts };
};

const labels = (options: GuidedInputOptions): string[] =>
  (options.choices ?? []).map((choice) => (typeof choice === "string" ? choice : choice.label));

describe("runConfigUi", () => {
  test("shows top-level groups and exits when dismissed", async () => {
    const { port, applied, prompts } = scriptedPort({ inputs: [null] });
    await runConfigUi(port);
    expect(applied).toEqual([]);
    expect(labels(prompts[0]!)).toEqual(["agent", "tui", "permissions"]);
  });

  test("navigates nested groups and edits an enum key", async () => {
    const { port, applied, prompts } = scriptedPort({
      inputs: ["agent", "context", "onLimit", "warn", null, null, null],
    });
    await runConfigUi(port);
    expect(applied).toEqual([{ path: "agent.context.onLimit", value: "warn" }]);
    expect(labels(prompts[1]!)).toContain("context");
    expect(labels(prompts[3]!)).toEqual(["warn"]);
  });

  test("edits a string-array key: add then save persists JSON", async () => {
    const { port, applied } = scriptedPort({
      inputs: [
        "agent",
        "llm",
        "tiers",
        "add an item",
        "gpt-5.6-terra",
        "save (2 items)",
        null,
        null,
        null,
      ],
      values: { "agent.llm.tiers": ["gpt-5.6-sol"] },
    });
    await runConfigUi(port);
    expect(applied).toEqual([
      { path: "agent.llm.tiers", value: JSON.stringify(["gpt-5.6-sol", "gpt-5.6-terra"]) },
    ]);
  });

  test("a secret key uses masked input and the dedicated secret write", async () => {
    const { port, applied, secrets, prompts } = scriptedPort({
      inputs: [
        "agent",
        "llm",
        "providers",
        "azure",
        "apiKey",
        "sk-live",
        null,
        null,
        null,
        null,
        null,
      ],
    });
    await runConfigUi(port);
    expect(applied).toEqual([]);
    expect(secrets).toEqual([{ path: "agent.llm.providers.azure.apiKey", value: "sk-live" }]);
    expect(prompts[5]?.masked).toBe(true);
  });

  test("Esc and Back each return one menu level", async () => {
    const { port, prompts } = scriptedPort({ inputs: ["agent", null, null] });
    await runConfigUi(port);
    expect(prompts).toHaveLength(3);
    expect(labels(prompts[1]!)).toContain("llm");
  });
});
