import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { preflight, resolveProvider } from "../src/model.ts";

const SAVED = { ...process.env };
beforeEach(() => {
  for (const k of ["AGENTJ_PROVIDER", "GOOGLE_VERTEX_PROJECT", "ANTHROPIC_API_KEY", "AZURE_BASE_URL", "AZURE_API_KEY", "AGENTJ_MODEL", "AGENTJ_BASE_URL", "AGENTJ_API_KEY"]) {
    delete process.env[k];
  }
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("resolveProvider", () => {
  test("defaults to vertex", () => {
    expect(resolveProvider(undefined)).toBe("vertex");
  });
  test("honors anthropic / azure / custom", () => {
    expect(resolveProvider("anthropic")).toBe("anthropic");
    expect(resolveProvider("azure")).toBe("azure");
    expect(resolveProvider("custom")).toBe("custom");
  });
  test("anything else → vertex", () => {
    expect(resolveProvider("openai")).toBe("vertex");
  });
});

describe("preflight", () => {
  test("vertex needs GOOGLE_VERTEX_PROJECT", () => {
    expect(preflight("vertex")).toContain("GOOGLE_VERTEX_PROJECT");
    process.env.GOOGLE_VERTEX_PROJECT = "p";
    expect(preflight("vertex")).toBeNull();
  });
  test("anthropic needs ANTHROPIC_API_KEY", () => {
    expect(preflight("anthropic")).toContain("ANTHROPIC_API_KEY");
    process.env.ANTHROPIC_API_KEY = "k";
    expect(preflight("anthropic")).toBeNull();
  });
  test("azure needs base url, key, and an explicit model", () => {
    expect(preflight("azure")).toContain("AZURE_BASE_URL");
    process.env.AZURE_BASE_URL = "https://x.services.ai.azure.com/models";
    expect(preflight("azure")).toContain("AZURE_API_KEY");
    process.env.AZURE_API_KEY = "k";
    expect(preflight("azure")).toContain("no default model");
    expect(preflight("azure", { modelId: "my-deployment" })).toBeNull();
  });
  test("custom needs a base url and a model (via flag or env)", () => {
    expect(preflight("custom")).toContain("base URL");
    expect(preflight("custom", { baseURL: "http://localhost:8080/v1" })).toContain("no default model");
    expect(preflight("custom", { baseURL: "http://localhost:8080/v1", modelId: "gpt-4o" })).toBeNull();
    process.env.AGENTJ_BASE_URL = "http://gw/v1";
    process.env.AGENTJ_MODEL = "some-model";
    expect(preflight("custom")).toBeNull();
  });
});
