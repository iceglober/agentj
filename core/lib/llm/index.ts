import type { LanguageModel } from "ai";
import { createAzureModelProvider } from "./azure-adapter";

export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * Serializable model selection; maps to future config keys
 * `llm.{provider,model,temperature,apiKey,...}`.
 *
 * Auth is config-first with env fallback: an explicit `apiKey` here wins,
 * otherwise each adapter falls back to its documented env vars and throws
 * early if neither is set.
 */
export interface LlmConfig {
  provider: ProviderName;
  model: string;
  /** Call setting; forward to the agent/generate call, not the model. */
  temperature?: number;
  apiKey?: string;
  /** azure only. */
  resourceName?: string;
}

/** Registry keyed by config value (`llm.provider`). */
export const llmProviders = {
  azure: createAzureModelProvider,
} satisfies Record<string, (config: Omit<LlmConfig, "provider" | "model" | "temperature">) => ModelFactory>;

export type ProviderName = keyof typeof llmProviders;

export const createModel = (config: LlmConfig): LanguageModel =>
  llmProviders[config.provider](config)(config.model);
