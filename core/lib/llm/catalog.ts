import type { ProviderName } from "./providers";

/**
 * Model suggestions come from the public models.dev catalog (free, no key), so
 * the picker's model column stays current without a hand-maintained list. Each
 * of our providers maps to a models.dev provider id; `openai-compatible` has no
 * fixed catalog (bring your own base URL + id), so it's free-text only.
 */
export const MODELS_DEV_URL = "https://models.dev/api.json";

const MODELS_DEV_PROVIDER: Record<ProviderName, string | null> = {
  azure: "azure",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  vertex: "google-vertex",
  bedrock: "amazon-bedrock",
  mistral: "mistral",
  cohere: "cohere",
  groq: "groq",
  deepseek: "deepseek",
  xai: "xai",
  togetherai: "togetherai",
  cerebras: "cerebras",
  perplexity: "perplexity",
  "openai-compatible": null,
};

interface CatalogModel {
  modalities?: { output?: string[] };
}
interface CatalogProvider {
  models?: Record<string, CatalogModel>;
}

/** A text-generating model — one whose output modality includes text. Filters
 *  out image/audio/embedding-only models the agent can't drive. */
const generatesText = (m: CatalogModel): boolean =>
  (m.modalities?.output ?? ["text"]).includes("text");

/**
 * Fetch models.dev and map it to `{ ourProvider: modelId[] }`, keeping only
 * text models. Never throws for a missing provider — an absent one is `[]`.
 */
export const fetchModelCatalog = async (
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<Record<string, string[]>> => {
  const response = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`models.dev request failed: ${response.status}`);
  const catalog = (await response.json()) as Record<string, CatalogProvider>;
  const out: Record<string, string[]> = {};
  for (const [provider, devId] of Object.entries(MODELS_DEV_PROVIDER)) {
    if (!devId) {
      out[provider] = [];
      continue;
    }
    const models = catalog[devId]?.models ?? {};
    out[provider] = Object.entries(models)
      .filter(([, m]) => generatesText(m))
      .map(([id]) => id)
      .sort();
  }
  return out;
};

let cached: Promise<Record<string, string[]>> | null = null;

/**
 * The model catalog, fetched once per process and memoized. A failed/offline
 * fetch resolves to an empty catalog — the picker's free-text entry still works.
 */
export const loadModelCatalog = (): Promise<Record<string, string[]>> => {
  if (!cached) cached = fetchModelCatalog().catch(() => ({}));
  return cached;
};
