import type { RunConfig } from "../lib/eval/config";
import type { LlmConfig } from "../lib/llm";
import { resolveAzureApiKey, type SecretStore } from "../lib/secrets";

const withApiKey = (llm: LlmConfig, apiKey: string): LlmConfig => ({
  ...llm,
  providers: {
    ...llm.providers,
    azure: { ...llm.providers?.azure, apiKey },
  },
});

/** Resolve eval credentials once and inject them only into in-memory configs. */
export const resolveEvalAuth = async (
  configs: readonly RunConfig[],
  baseLlm: LlmConfig,
  options: { env?: Record<string, string | undefined>; store: SecretStore },
): Promise<{ configs: RunConfig[]; baseLlm: LlmConfig }> => {
  const key = await resolveAzureApiKey(options);
  if (key.status !== "resolved") {
    throw new Error(
      key.status === "store-unavailable"
        ? "Azure API key unavailable: the secure secret store could not be read."
        : "Azure API key missing; run: glorious config set --secret providers.azure.api_key",
    );
  }
  return {
    configs: configs.map((config) => ({
      ...config,
      agent: { ...config.agent, llm: withApiKey(config.agent.llm, key.apiKey) },
    })),
    baseLlm: withApiKey(baseLlm, key.apiKey),
  };
};
