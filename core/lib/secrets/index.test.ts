import { describe, expect, mock, test } from "bun:test";
import {
  AZURE_API_KEY_ACCOUNT,
  AZURE_SECRET_SERVICE,
  resolveAzureApiKey,
  type SecretStore,
  SecretStoreUnavailableError,
} from "./index";

const fixtureSecret = "fixture-secret-must-not-leak";

function makeStore(get: SecretStore["get"]): SecretStore {
  return {
    get,
    set: async () => {},
    delete: async () => false,
  };
}

describe("resolveAzureApiKey", () => {
  test("prefers Foundry then Azure environment credentials without reading the store", async () => {
    const get = mock<SecretStore["get"]>();
    const store = makeStore(get);

    await expect(
      resolveAzureApiKey({
        env: {
          AZURE_FOUNDRY_API_KEY: "foundry-key",
          AZURE_API_KEY: "azure-key",
        },
        store,
      }),
    ).resolves.toEqual({
      status: "resolved",
      apiKey: "foundry-key",
      source: "azure-foundry-api-key",
    });

    await expect(
      resolveAzureApiKey({ env: { AZURE_API_KEY: "azure-key" }, store }),
    ).resolves.toEqual({
      status: "resolved",
      apiKey: "azure-key",
      source: "azure-api-key",
    });

    expect(get).not.toHaveBeenCalled();
  });

  test("resolves the Azure key from the fixed keychain service and account", async () => {
    const get = mock<SecretStore["get"]>();
    get.mockResolvedValue("stored-key");

    await expect(resolveAzureApiKey({ env: {}, store: makeStore(get) })).resolves.toEqual({
      status: "resolved",
      apiKey: "stored-key",
      source: "secret-store",
    });

    expect(AZURE_SECRET_SERVICE).toBe("agentj");
    expect(AZURE_API_KEY_ACCOUNT).toBe("azure-api-key");
    expect(get).toHaveBeenCalledWith(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT);
  });

  test("reports a missing key without including a fixture secret in the status", async () => {
    const get = mock<SecretStore["get"]>();
    get.mockResolvedValue(undefined);

    const result = await resolveAzureApiKey({ env: {}, store: makeStore(get) });

    expect(result).toEqual({ status: "missing" });
    expect(JSON.stringify(result)).not.toContain(fixtureSecret);
  });

  test("redacts unavailable store errors and never includes a fixture secret", async () => {
    const unavailableStore = makeStore(async () => {
      throw new Error(`native keychain error: ${fixtureSecret}`);
    });

    const result = await resolveAzureApiKey({ env: {}, store: unavailableStore });

    expect(result.status).toBe("store-unavailable");
    if (result.status !== "store-unavailable") throw new Error("Expected unavailable store");
    expect(result.error).toBeInstanceOf(SecretStoreUnavailableError);
    expect(result.error).toMatchObject({
      name: "SecretStoreUnavailableError",
      message: "The secure secret store is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain(fixtureSecret);
    expect(String(result.error)).not.toContain(fixtureSecret);
  });

  test("reports a missing store as unavailable without exposing a secret", async () => {
    const result = await resolveAzureApiKey({ env: {} });

    expect(result.status).toBe("store-unavailable");
    expect(JSON.stringify(result)).not.toContain(fixtureSecret);
  });
});
