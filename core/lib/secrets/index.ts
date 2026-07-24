/** Keychain service for all of glorious's secrets. */
export const SECRET_SERVICE = "glorious";
/** The keychain account holding a provider's API key. */
export const providerKeyAccount = (provider: string): string => `${provider}-api-key`;

export const AZURE_SECRET_SERVICE = SECRET_SERVICE;
export const AZURE_API_KEY_ACCOUNT = providerKeyAccount("azure");

export type AzureApiKeySource = "azure-foundry-api-key" | "azure-api-key" | "secret-store";

export interface SecretStore {
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export class SecretStoreUnavailableError extends Error {
  constructor() {
    super("The secure secret store is unavailable.");
    this.name = "SecretStoreUnavailableError";
  }
}

export type AzureApiKeyResolution =
  | {
      status: "resolved";
      apiKey: string;
      source: AzureApiKeySource;
    }
  | {
      status: "missing";
    }
  | {
      status: "store-unavailable";
      error: SecretStoreUnavailableError;
    };

export interface ResolveAzureApiKeyOptions {
  env?: Record<string, string | undefined>;
  store?: SecretStore;
}

function resolved(apiKey: string, source: AzureApiKeySource): AzureApiKeyResolution {
  return { status: "resolved", apiKey, source };
}

export async function resolveAzureApiKey({
  env = process.env,
  store,
}: ResolveAzureApiKeyOptions = {}): Promise<AzureApiKeyResolution> {
  const foundryApiKey = env.AZURE_FOUNDRY_API_KEY;
  if (foundryApiKey) return resolved(foundryApiKey, "azure-foundry-api-key");

  const azureApiKey = env.AZURE_API_KEY;
  if (azureApiKey) return resolved(azureApiKey, "azure-api-key");

  if (!store) return { status: "store-unavailable", error: new SecretStoreUnavailableError() };

  try {
    const apiKey = await store.get(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT);
    return apiKey ? resolved(apiKey, "secret-store") : { status: "missing" };
  } catch {
    return { status: "store-unavailable", error: new SecretStoreUnavailableError() };
  }
}

export async function hasAzureApiKey(options?: ResolveAzureApiKeyOptions): Promise<boolean> {
  return (await resolveAzureApiKey(options)).status === "resolved";
}

/**
 * A provider's API key from the keychain (`<provider>-api-key`). The AI SDK
 * reads each provider's own env var when this is absent, so a missing key is
 * not an error here — the caller only injects a key it actually found.
 */
export async function resolveProviderKey(
  provider: string,
  store?: SecretStore,
): Promise<string | undefined> {
  if (!store) return undefined;
  try {
    return await store.get(SECRET_SERVICE, providerKeyAccount(provider));
  } catch {
    return undefined;
  }
}

/** Whether a provider has a key in the keychain. */
export async function hasProviderKey(provider: string, store?: SecretStore): Promise<boolean> {
  return Boolean(await resolveProviderKey(provider, store));
}
