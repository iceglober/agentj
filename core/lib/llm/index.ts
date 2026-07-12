import type { LanguageModel } from "ai";
import {
  createAzureModelProvider,
  type AzureModelConfig,
} from "./azure-adapter";

export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * Per-provider connection/auth settings. Every provider needs its own props
 * (azure: resourceName; vertex: project/location; bedrock: region; ...), so
 * each gets a block here, added alongside its adapter.
 */
export interface ProviderConfigs {
  azure: AzureModelConfig;
}

export type ProviderName = keyof ProviderConfigs;

/**
 * Serializable model selection; maps to future config keys
 * `llm.{provider,model,temperature}` and `llm.providers.{name}.*`.
 *
 * Auth and provider props are config-first with env fallback: explicit values
 * in `providers.{name}` win, otherwise each adapter falls back to its
 * documented env vars and throws early if a required one is missing.
 */
export interface LlmConfig {
  provider: ProviderName;
  model: string;
  /** Call setting; forward to the agent/generate call, not the model. */
  temperature?: number;
  providers?: Partial<ProviderConfigs>;
}

/** Registry keyed by config value (`llm.provider`). */
export const llmProviders: {
  [K in ProviderName]: (config?: ProviderConfigs[K]) => ModelFactory;
} = {
  azure: createAzureModelProvider,
};

export const createModel = (config: LlmConfig): LanguageModel => {
  // The mapped registry ties each key to its own config type; indexing with a
  // union key erases that link, so re-assert it here — the shape is enforced
  // where it matters, on the registry itself.
  const provider = llmProviders[config.provider] as (
    c?: ProviderConfigs[ProviderName],
  ) => ModelFactory;
  return provider(config.providers?.[config.provider])(config.model);
};
