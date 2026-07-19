import { createAzure } from "@ai-sdk/azure";
import z from "zod";
import type { ModelFactory } from "./ai-sdk-adapter";

export const azureModelConfigSchema = z.object({
  /** Falls back to AZURE_FOUNDRY_API_KEY, then AZURE_API_KEY (SDK default). */
  apiKey: z.string().optional(),
  /** Falls back to AZURE_RESOURCE_NAME (SDK default). */
  resourceName: z.string().optional(),
});

export type AzureModelConfig = z.infer<typeof azureModelConfigSchema>;

/**
 * Deadline for one model HTTP request. Long reasoning turns legitimately run
 * past Bun's hardcoded 5-minute fetch timeout ("The operation timed out"),
 * which killed real runs mid-turn; supplying an explicit signal replaces that
 * incidental default with a deliberate ceiling for genuinely hung requests.
 */
export const LLM_REQUEST_TIMEOUT_MS = 30 * 60_000;

/** The provider's fetch with the request deadline attached, composed with any
 *  caller signal (turn aborts still win). Exported for tests. */
export const fetchWithRequestDeadline = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> => {
  const deadline = AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
};

export const createAzureModelProvider = (config: AzureModelConfig = {}): ModelFactory => {
  const apiKey = config.apiKey ?? process.env.AZURE_FOUNDRY_API_KEY;
  if (!apiKey && !process.env.AZURE_API_KEY)
    throw new Error(
      "Azure API key missing: set llm.apiKey in config, or AZURE_FOUNDRY_API_KEY / AZURE_API_KEY in the environment.",
    );
  return (modelId) =>
    createAzure({
      apiKey,
      resourceName: config.resourceName,
      // Bun's fetch type adds `preconnect`, which the wrapper has no use for;
      // assert at this vendor boundary rather than emulating runtime extras.
      fetch: fetchWithRequestDeadline as unknown as typeof fetch,
    })(modelId);
};
