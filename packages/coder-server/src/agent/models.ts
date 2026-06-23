// Model + price resolution. v1 is Anthropic-direct via the Vercel AI SDK; tiers map to
// concrete model ids, and a small price table by family powers the Ledger receipt.
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";
import type { Tier } from "coder-core";

/** Tier → concrete Anthropic model id. Cheapest tiers share Haiku in v1. */
export const TIER_MODELS: Record<Tier, string> = {
  deep: "claude-opus-4-8",
  mid: "claude-sonnet-4-6",
  fast: "claude-haiku-4-5-20251001",
  cheap: "claude-haiku-4-5-20251001",
};

/** USD per 1M tokens, keyed by model family. */
export type Family = "opus" | "sonnet" | "haiku";
export const PRICES: Record<Family, { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

/** Map a model id to its pricing family; unknown ids fall back to sonnet. */
export function familyOf(modelId: string): Family {
  const id = modelId.toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  return "sonnet";
}

/** Cost in USD from token usage (cache tokens aren't surfaced by the SDK in v1). */
export function costOf(modelId: string, usage: { promptTokens: number; completionTokens: number }): number {
  const p = PRICES[familyOf(modelId)];
  return (usage.promptTokens * p.input + usage.completionTokens * p.output) / 1_000_000;
}

export interface ResolvedModel {
  model: LanguageModelV1;
  modelId: string;
  family: Family;
}

/**
 * Resolve a runnable model. `modelId` (or CODER_MODEL upstream) wins over `tier`.
 * Requires ANTHROPIC_API_KEY — callers preflight and surface a clear error.
 */
export function resolveModel(opts: { tier: Tier; modelId?: string; apiKey?: string }): ResolvedModel {
  const modelId = opts.modelId ?? TIER_MODELS[opts.tier];
  const anthropic = createAnthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  return { model: anthropic.languageModel(modelId), modelId, family: familyOf(modelId) };
}
