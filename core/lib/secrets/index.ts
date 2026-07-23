export const AZURE_SECRET_SERVICE = "glorious";
export const AZURE_API_KEY_ACCOUNT = "azure-api-key";

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
