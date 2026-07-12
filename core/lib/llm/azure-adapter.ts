import { createAzure } from "@ai-sdk/azure";
import type { ModelFactory } from "./index";

export interface AzureProviderDeps {
  resourceName: string;
  apiKey: string;
}

export const createAzureModelProvider =
  (deps: AzureProviderDeps): ModelFactory =>
  (modelId) =>
    createAzure(deps)(modelId);
