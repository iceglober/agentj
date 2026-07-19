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
/** A connection that hung once tends to hang again — retries fail faster. */
export const LLM_RETRY_TIMEOUT_MS = 10 * 60_000;
/** Total tries per request: the first attempt plus two retries. */
export const LLM_REQUEST_ATTEMPTS = 3;

/**
 * Errors worth a second attempt: our own deadline firing (TimeoutError) or the
 * connection dying under us. HTTP error *responses* return normally and are
 * retried by the AI SDK's own policy; a caller abort is honored, never retried.
 */
const isTransientRequestError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "ConnectionError" ||
      error.name === "ConnectTimeoutError" ||
      error.name === "SocketError"));

const backoff = (attempt: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 500 * attempt);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * The provider's fetch with a request deadline attached (composed with any
 * caller signal — turn aborts still win) and a bounded retry for transient
 * request failures. Retrying here re-sends exactly one HTTP request; the tool
 * loop above never re-executes tools. Exported for tests.
 */
export const fetchWithRequestDeadline = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> => {
  for (let attempt = 1; ; attempt += 1) {
    const deadline = AbortSignal.timeout(
      attempt === 1 ? LLM_REQUEST_TIMEOUT_MS : LLM_RETRY_TIMEOUT_MS,
    );
    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
    } catch (error) {
      const abortedByCaller = init?.signal?.aborted === true;
      if (abortedByCaller || attempt >= LLM_REQUEST_ATTEMPTS || !isTransientRequestError(error)) {
        throw error;
      }
      await backoff(attempt, init?.signal);
      if (init?.signal?.aborted) throw error;
    }
  }
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
