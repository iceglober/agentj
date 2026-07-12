import { createAzure } from "@ai-sdk/azure";
import z from "zod";
import type { ModelFactory } from "./index";

export const azureModelConfigSchema = z.object({
  /** Falls back to AZURE_FOUNDRY_API_KEY, then AZURE_API_KEY (SDK default). */
  apiKey: z.string().optional(),
  /** Falls back to AZURE_RESOURCE_NAME (SDK default). */
  resourceName: z.string().optional(),
});

export type AzureModelConfig = z.infer<typeof azureModelConfigSchema>;

export const createAzureModelProvider = (
  config: AzureModelConfig = {},
): ModelFactory => {
  const apiKey = config.apiKey ?? process.env.AZURE_FOUNDRY_API_KEY;
  if (!apiKey && !process.env.AZURE_API_KEY)
    throw new Error(
      "Azure API key missing: set llm.apiKey in config, or AZURE_FOUNDRY_API_KEY / AZURE_API_KEY in the environment.",
    );
  return (modelId) =>
    createAzure({ apiKey, resourceName: config.resourceName })(modelId);
};
