import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogle } from "@ai-sdk/google";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity } from "@ai-sdk/perplexity";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import z from "zod";
import {
  type AzureModelConfig,
  azureModelConfigSchema,
  createAzureModelProvider,
  fetchWithRequestDeadline,
} from "./azure-adapter";

/** A model constructor bound to one provider's auth; each factory returns one. */
export type ModelFactory = (modelId: string) => LanguageModel;

// Every provider shares one request deadline + retry (see azure-adapter). Bun's
// fetch type adds `preconnect`, unused here — assert at the vendor boundary.
const DEADLINE_FETCH = fetchWithRequestDeadline as unknown as typeof fetch;

/**
 * Most `@ai-sdk/*` providers share one shape: `createX({ apiKey?, baseURL? })`
 * returns a callable `provider(modelId)`. The SDK reads the provider's own env
 * var (OPENAI_API_KEY, …) when apiKey is absent, so config stays optional.
 */
export const keyProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
});
export type KeyProviderConfig = z.infer<typeof keyProviderConfigSchema>;

// The vendor create fns have provider-specific return types that are all
// callable ModelFactories; unify them at this boundary.
type VendorCreate = (opts: {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}) => ModelFactory;

const keyBased =
  (create: VendorCreate) =>
  (config: KeyProviderConfig = {}): ModelFactory =>
  (modelId) =>
    create({ apiKey: config.apiKey, baseURL: config.baseURL, fetch: DEADLINE_FETCH })(modelId);

const asVendor = (create: unknown): VendorCreate => create as VendorCreate;

// --- Special-auth providers ---------------------------------------------------

/** OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, …): needs a base URL. */
export const openAICompatibleConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  /** Provider label sent to the endpoint; defaults to `openai-compatible`. */
  name: z.string().optional(),
});
export type OpenAICompatibleConfig = z.infer<typeof openAICompatibleConfigSchema>;

const createOpenAICompatibleProvider =
  (config: OpenAICompatibleConfig = {}): ModelFactory =>
  (modelId) => {
    if (!config.baseURL)
      throw new Error(
        "openai-compatible provider needs a base URL: set agent.llm.providers.openai-compatible.baseURL.",
      );
    return createOpenAICompatible({
      name: config.name ?? "openai-compatible",
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      fetch: DEADLINE_FETCH,
    })(modelId);
  };

/** AWS Bedrock: an API key, or the standard AWS credential chain (env/profile). */
export const bedrockConfigSchema = z.object({
  apiKey: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),
  baseURL: z.string().url().optional(),
});
export type BedrockConfig = z.infer<typeof bedrockConfigSchema>;

const createBedrockProvider =
  (config: BedrockConfig = {}): ModelFactory =>
  (modelId) =>
    asVendor(createAmazonBedrock)({
      ...config,
      fetch: DEADLINE_FETCH,
    } as never)(modelId);

/** Google Vertex: project + location, authenticated via Application Default Credentials. */
export const vertexConfigSchema = z.object({
  project: z.string().optional(),
  location: z.string().optional(),
  baseURL: z.string().url().optional(),
});
export type VertexConfig = z.infer<typeof vertexConfigSchema>;

const createVertexProvider =
  (config: VertexConfig = {}): ModelFactory =>
  (modelId) =>
    asVendor(createGoogleVertex)({ ...config, fetch: DEADLINE_FETCH } as never)(modelId);

// --- Registry -----------------------------------------------------------------

/** Per-provider connection/auth settings — each provider's config shape. */
export interface ProviderConfigs {
  azure: AzureModelConfig;
  openai: KeyProviderConfig;
  anthropic: KeyProviderConfig;
  google: KeyProviderConfig;
  mistral: KeyProviderConfig;
  cohere: KeyProviderConfig;
  groq: KeyProviderConfig;
  deepseek: KeyProviderConfig;
  xai: KeyProviderConfig;
  togetherai: KeyProviderConfig;
  cerebras: KeyProviderConfig;
  perplexity: KeyProviderConfig;
  "openai-compatible": OpenAICompatibleConfig;
  bedrock: BedrockConfig;
  vertex: VertexConfig;
}

export type ProviderName = keyof ProviderConfigs;

/** Registry keyed by `llm.provider`. Declaration order is the display order. */
export const llmProviders: {
  [K in ProviderName]: (config?: ProviderConfigs[K]) => ModelFactory;
} = {
  azure: createAzureModelProvider,
  openai: keyBased(asVendor(createOpenAI)),
  anthropic: keyBased(asVendor(createAnthropic)),
  google: keyBased(asVendor(createGoogle)),
  mistral: keyBased(asVendor(createMistral)),
  cohere: keyBased(asVendor(createCohere)),
  groq: keyBased(asVendor(createGroq)),
  deepseek: keyBased(asVendor(createDeepSeek)),
  xai: keyBased(asVendor(createXai)),
  togetherai: keyBased(asVendor(createTogetherAI)),
  cerebras: keyBased(asVendor(createCerebras)),
  perplexity: keyBased(asVendor(createPerplexity)),
  "openai-compatible": createOpenAICompatibleProvider,
  bedrock: createBedrockProvider,
  vertex: createVertexProvider,
};

/** Provider names; the config `provider` enum derives from here. */
export const providerNames = Object.keys(llmProviders) as [ProviderName, ...ProviderName[]];

/** The `agent.llm.providers` schema: every provider's config, all optional. */
export const providersConfigSchema = z.object({
  azure: azureModelConfigSchema.optional(),
  openai: keyProviderConfigSchema.optional(),
  anthropic: keyProviderConfigSchema.optional(),
  google: keyProviderConfigSchema.optional(),
  mistral: keyProviderConfigSchema.optional(),
  cohere: keyProviderConfigSchema.optional(),
  groq: keyProviderConfigSchema.optional(),
  deepseek: keyProviderConfigSchema.optional(),
  xai: keyProviderConfigSchema.optional(),
  togetherai: keyProviderConfigSchema.optional(),
  cerebras: keyProviderConfigSchema.optional(),
  perplexity: keyProviderConfigSchema.optional(),
  "openai-compatible": openAICompatibleConfigSchema.optional(),
  bedrock: bedrockConfigSchema.optional(),
  vertex: vertexConfigSchema.optional(),
});

/**
 * Providers whose only credential is an API key stored in the keychain
 * (`config set --secret providers.<name>.apiKey`). Bedrock and Vertex use their
 * cloud credential chains, so they're excluded from the key-entry flow.
 */
export const KEY_PROVIDERS: readonly ProviderName[] = [
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
];
