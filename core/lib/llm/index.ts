import type { LanguageModel } from "ai";
import z from "zod";
import {
  azureModelConfigSchema,
  createAzureModelProvider,
  type AzureModelConfig,
} from "./azure-adapter";

export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * Per-provider connection/auth settings. Every provider needs its own props
 * (azure: resourceName; vertex: project/location; bedrock: region; ...), so
 * each adapter exports its own schema and gets a block here.
 */
export interface ProviderConfigs {
  azure: AzureModelConfig;
}

export type ProviderName = keyof ProviderConfigs;

/** Registry keyed by config value (`llm.provider`). */
export const llmProviders: {
  [K in ProviderName]: (config?: ProviderConfigs[K]) => ModelFactory;
} = {
  azure: createAzureModelProvider,
};

const providerNames = Object.keys(llmProviders) as [
  ProviderName,
  ...ProviderName[],
];

/**
 * Serializable model selection; the `llm.*` section of the agent config.
 *
 * Auth and provider props are config-first with env fallback: explicit values
 * in `providers.{name}` win, otherwise each adapter falls back to its
 * documented env vars and throws early if a required one is missing.
 */
export const llmConfigSchema = z.object({
  provider: z.enum(providerNames).default("azure"),
  model: z.string().default("gpt-5.6-sol"),
  /** Call setting; forward to the agent/generate call, not the model. */
  temperature: z.number().min(0).max(2).optional(),
  providers: z
    .object({
      azure: azureModelConfigSchema.optional(),
    })
    .optional(),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

export const createModel = (config: LlmConfig): LanguageModel => {
  // The mapped registry ties each key to its own config type; indexing with a
  // union key erases that link, so re-assert it here — the shape is enforced
  // where it matters, on the registry itself.
  const provider = llmProviders[config.provider] as (
    c?: ProviderConfigs[ProviderName],
  ) => ModelFactory;
  return provider(config.providers?.[config.provider])(config.model);
};
