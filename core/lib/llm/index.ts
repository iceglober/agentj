import type { LanguageModel } from "ai";
import { createAzureModelProvider, type AzureProviderDeps } from "./azure-adapter";

export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * Serializable model selection; maps to future config keys
 * `llm.{provider,model,temperature,...}`. Secrets and provider wiring stay
 * out of it — they come in through `ProviderDeps` at the entrypoint.
 */
export interface LlmConfig {
  provider: ProviderName;
  model: string;
  /** Call setting; forward to the agent/generate call, not the model. */
  temperature?: number;
}

export interface ProviderDeps {
  azure: AzureProviderDeps;
}

/** Registry keyed by config value (`llm.provider`). */
export const llmProviders: {
  [K in keyof ProviderDeps]: (deps: ProviderDeps[K]) => ModelFactory;
} = {
  azure: createAzureModelProvider,
};

export type ProviderName = keyof ProviderDeps;

export const createModel = <K extends ProviderName>(
  config: LlmConfig & { provider: K },
  deps: ProviderDeps[K],
): LanguageModel => llmProviders[config.provider](deps)(config.model);
