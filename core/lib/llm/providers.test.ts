import { describe, expect, test } from "bun:test";
import { KEY_PROVIDERS, llmProviders, providerNames, providersConfigSchema } from "./providers";

describe("provider registry", () => {
  test("registers every AI SDK provider we support", () => {
    expect(providerNames).toEqual([
      "azure",
      "openai",
      "anthropic",
      "google",
      "mistral",
      "cohere",
      "groq",
      "deepseek",
      "xai",
      "togetherai",
      "cerebras",
      "perplexity",
      "openai-compatible",
      "bedrock",
      "vertex",
    ]);
  });

  test("every provider instantiates a language model from config", () => {
    const config = {
      apiKey: "sk-test",
      baseURL: "https://api.example.com/v1",
      name: "compat",
      region: "us-east-1",
      project: "proj",
      location: "us-central1",
    };
    for (const name of providerNames) {
      const factory = llmProviders[name] as (c?: typeof config) => (id: string) => unknown;
      const model = factory(config)("some-model");
      expect(model, `${name} should build a model`).toBeTruthy();
    }
  });

  test("openai-compatible requires a base URL", () => {
    expect(() => llmProviders["openai-compatible"]({})("m")).toThrow(/base URL/);
  });

  test("the providers schema accepts each provider's config and rejects a bad url", () => {
    const parsed = providersConfigSchema.parse({
      openai: { apiKey: "k" },
      azure: { apiKey: "k", resourceName: "r" },
      bedrock: { region: "us-east-1" },
      vertex: { project: "p", location: "us" },
    });
    expect(parsed.openai?.apiKey).toBe("k");
    expect(() => providersConfigSchema.parse({ openai: { baseURL: "not-a-url" } })).toThrow();
  });

  test("bedrock and vertex are excluded from the API-key entry set", () => {
    expect(KEY_PROVIDERS).toContain("openai");
    expect(KEY_PROVIDERS).not.toContain("bedrock");
    expect(KEY_PROVIDERS).not.toContain("vertex");
  });
});
