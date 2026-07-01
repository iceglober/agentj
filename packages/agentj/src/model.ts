// Model resolution. Four ways to reach a model via the Vercel AI SDK:
//   vertex     — Google Vertex AI serving Gemini (default)
//   anthropic  — Anthropic-direct serving Claude
//   azure      — Azure AI Foundry's OpenAI-compatible inference endpoint
//   custom     — any OpenAI-compatible endpoint (a gateway like Bifrost, a local server, etc.)
// Tier-less, catalog-less: pick a default model per provider where one is canonical; azure and custom
// address models by a name you choose, so they require --model / AGENTJ_MODEL.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** Where the model is served from — and, with it, which model family runs. */
export type Provider = "vertex" | "anthropic" | "azure" | "custom";

/** Default model for providers with a canonical id. Azure/custom have none (name one with --model). */
const DEFAULT_MODEL: Partial<Record<Provider, string>> = {
  vertex: "gemini-2.5-pro",
  anthropic: "claude-opus-4-8",
};

/** Resolve the active provider from a string (flag or `AGENTJ_PROVIDER`); default Vertex (Gemini). */
export function resolveProvider(value = process.env.AGENTJ_PROVIDER): Provider {
  if (value === "anthropic" || value === "azure" || value === "custom") return value;
  return "vertex";
}

/** Base URL for the custom OpenAI-compatible provider: explicit (--base-url) wins over AGENTJ_BASE_URL. */
function customBaseURL(explicit?: string): string {
  return explicit ?? process.env.AGENTJ_BASE_URL ?? "";
}

export interface ModelSelector {
  provider?: Provider;
  modelId?: string;
  /** Base URL for the `custom` provider (from --base-url). Ignored by the other providers. */
  baseURL?: string;
}

/**
 * Check provider credentials/config before a run so callers can surface a clear, actionable error
 * instead of a mid-stream SDK failure. Returns null when ready.
 *   - vertex:    GOOGLE_VERTEX_PROJECT (auth via gcloud application-default credentials)
 *   - anthropic: ANTHROPIC_API_KEY
 *   - azure:     AZURE_BASE_URL + AZURE_API_KEY + a model (the Foundry deployment name)
 *   - custom:    a base URL (AGENTJ_BASE_URL / --base-url) + a model (AGENTJ_MODEL / --model)
 */
export function preflight(provider: Provider, opts: ModelSelector = {}): string | null {
  const modelId = opts.modelId ?? process.env.AGENTJ_MODEL;
  if (provider === "vertex") {
    return process.env.GOOGLE_VERTEX_PROJECT
      ? null
      : "Vertex provider needs GOOGLE_VERTEX_PROJECT set (auth via `gcloud auth application-default login`; GOOGLE_VERTEX_LOCATION optional, defaults to global).";
  }
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ? null : "Anthropic provider needs ANTHROPIC_API_KEY set.";
  }
  if (provider === "azure") {
    if (!process.env.AZURE_BASE_URL) {
      return "Azure provider needs AZURE_BASE_URL set (your Foundry OpenAI-compatible endpoint, e.g. https://<resource>.services.ai.azure.com/models).";
    }
    if (!process.env.AZURE_API_KEY) return "Azure provider needs AZURE_API_KEY set.";
    if (!modelId) return "Azure provider has no default model — set AGENTJ_MODEL or pass --model with your Foundry deployment name.";
    return null;
  }
  // custom
  if (!customBaseURL(opts.baseURL)) {
    return "Custom provider needs a base URL — set AGENTJ_BASE_URL or pass --base-url (e.g. a Bifrost gateway: http://localhost:8080/v1).";
  }
  if (!modelId) return "Custom provider has no default model — set AGENTJ_MODEL or pass --model.";
  return null;
}

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  provider: Provider;
}

/**
 * Resolve a runnable model. `modelId` (or AGENTJ_MODEL) wins over the provider default. Callers
 * preflight first. Providers read their config from the environment:
 *   - vertex:  GOOGLE_VERTEX_* (project + optional location); GCP application-default credentials.
 *              Location defaults to `global` (serves every Gemini model). We do NOT override baseURL —
 *              the v5 provider handles `global` natively on /v1beta1, which multi-turn function calling
 *              needs (it rejects the function-call `id` field on /v1).
 *   - anthropic: ANTHROPIC_API_KEY.
 *   - azure:   AZURE_BASE_URL + AZURE_API_KEY (+ optional AZURE_API_VERSION as a query param).
 *   - custom:  AGENTJ_BASE_URL (or opts.baseURL) + optional AGENTJ_API_KEY (sent as a Bearer token).
 */
export function resolveModel(opts: ModelSelector = {}): ResolvedModel {
  const provider = opts.provider ?? resolveProvider();
  const modelId = opts.modelId ?? process.env.AGENTJ_MODEL ?? DEFAULT_MODEL[provider];
  if (!modelId) throw new Error(`No model id for provider "${provider}" — set AGENTJ_MODEL or pass --model (azure/custom have no default).`);

  let model: LanguageModel;
  if (provider === "vertex") {
    model = createVertex({
      project: process.env.GOOGLE_VERTEX_PROJECT,
      location: process.env.GOOGLE_VERTEX_LOCATION || "global",
    }).languageModel(modelId);
  } else if (provider === "anthropic") {
    model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).languageModel(modelId);
  } else if (provider === "azure") {
    const apiVersion = process.env.AZURE_API_VERSION;
    model = createOpenAICompatible({
      name: "azure",
      baseURL: process.env.AZURE_BASE_URL ?? "",
      apiKey: process.env.AZURE_API_KEY,
      ...(apiVersion ? { queryParams: { "api-version": apiVersion } } : {}),
    }).languageModel(modelId);
  } else {
    // custom: any OpenAI-compatible endpoint (Bifrost gateway, local server, self-hosted, …).
    model = createOpenAICompatible({
      name: "custom",
      baseURL: customBaseURL(opts.baseURL),
      apiKey: process.env.AGENTJ_API_KEY,
    }).languageModel(modelId);
  }
  return { model, modelId, provider };
}
