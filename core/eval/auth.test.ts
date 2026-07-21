import { describe, expect, test } from "bun:test";
import { runConfigSchema } from "../lib/eval/config";
import { llmConfigSchema } from "../lib/llm";
import type { SecretStore } from "../lib/secrets";
import { resolveEvalAuth } from "./auth";

const store = (value?: string): SecretStore => ({
  get: async () => value,
  set: async () => {},
  delete: async () => false,
});

describe("resolveEvalAuth", () => {
  test("injects a keychain credential into run and judge configs without mutating inputs", async () => {
    const config = runConfigSchema.parse({
      id: "luna",
      agent: { llm: { model: "gpt-5.6-luna", providers: { azure: { resourceName: "r" } } } },
    });
    const baseLlm = llmConfigSchema.parse({ providers: { azure: { resourceName: "judge" } } });

    const resolved = await resolveEvalAuth([config], baseLlm, {
      env: {},
      store: store("keychain-secret"),
    });

    expect(resolved.configs[0]?.agent.llm.providers?.azure).toEqual({
      resourceName: "r",
      apiKey: "keychain-secret",
    });
    expect(resolved.baseLlm.providers?.azure).toEqual({
      resourceName: "judge",
      apiKey: "keychain-secret",
    });
    expect(config.agent.llm.providers?.azure?.apiKey).toBeUndefined();
    expect(baseLlm.providers?.azure?.apiKey).toBeUndefined();
  });

  test("fails once with actionable copy when no credential is available", async () => {
    await expect(
      resolveEvalAuth([], llmConfigSchema.parse({}), { env: {}, store: store() }),
    ).rejects.toThrow("agentj config set --secret providers.azure.api_key");
  });
});
