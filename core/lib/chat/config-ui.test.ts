import { describe, expect, test } from "bun:test";
import { type ConfigUiPort, runConfigUi } from "./config-ui";

/**
 * A scripted port: `selects`/`texts`/`secrets` are consumed in order as those
 * prompts are reached, `values` supplies current reads, and every apply is
 * recorded.
 */
const scriptedPort = (script: {
  selects?: (string | null)[];
  texts?: (string | null)[];
  secrets?: (string | null)[];
  values?: Record<string, unknown>;
}): { port: ConfigUiPort; applied: { path: string; value: string; secret?: boolean }[] } => {
  const selects = [...(script.selects ?? [])];
  const texts = [...(script.texts ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const applied: { path: string; value: string; secret?: boolean }[] = [];
  const port: ConfigUiPort = {
    select: async () => (selects.length ? (selects.shift() ?? null) : null),
    text: async () => (texts.length ? (texts.shift() ?? null) : null),
    secret: async () => (secrets.length ? (secrets.shift() ?? null) : null),
    read: async (path) => script.values?.[path],
    apply: async (path, value, options) => {
      applied.push({ path, value, ...(options?.secret ? { secret: true } : {}) });
      return true;
    },
    note: () => {},
  };
  return { port, applied };
};

describe("runConfigUi", () => {
  test("exits immediately when the menu is dismissed", async () => {
    const { port, applied } = scriptedPort({ selects: [null] });
    await runConfigUi(port);
    expect(applied).toEqual([]);
  });

  test("edits an enum key by selecting a value", async () => {
    // menu → pick agent.context.onLimit, editor → pick "compact", menu → exit.
    const { port, applied } = scriptedPort({ selects: ["agent.context.onLimit", "compact", null] });
    await runConfigUi(port);
    expect(applied).toEqual([{ path: "agent.context.onLimit", value: "compact" }]);
  });

  test("edits a string-array key: add then save persists JSON", async () => {
    const { port, applied } = scriptedPort({
      // menu → tiers, array-menu → add, (text) → item, array-menu → save, menu → exit
      selects: ["agent.llm.tiers", "add", "save", null],
      texts: ["gpt-5.6-terra"],
      values: { "agent.llm.tiers": ["gpt-5.6-sol"] },
    });
    await runConfigUi(port);
    expect(applied).toEqual([
      { path: "agent.llm.tiers", value: JSON.stringify(["gpt-5.6-sol", "gpt-5.6-terra"]) },
    ]);
  });

  test("a secret key routes through masked entry and the secret flag", async () => {
    const { port, applied } = scriptedPort({
      selects: ["agent.llm.providers.azure.apiKey", null],
      secrets: ["sk-live"],
    });
    await runConfigUi(port);
    expect(applied).toEqual([
      { path: "agent.llm.providers.azure.apiKey", value: "sk-live", secret: true },
    ]);
  });
});
