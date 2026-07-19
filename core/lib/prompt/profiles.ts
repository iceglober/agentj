import { COMPACT_PRIMARY, STANDALONE_EXECUTOR } from "./base";
import { DEEPSEEK_DELTA, GPT54_DELTA } from "./blocks";
import type { RenderFlags } from "./index";

/**
 * Sampling + provider call recommendations for a model. These are advisory:
 * the composer passes them through, but the live `llm.*` config upstream can
 * override any of them.
 */
export interface ModelParams {
  temperature?: number;
  topP?: number;
  /** Provider-scoped call options, e.g. { openai: { reasoningEffort: "low", textVerbosity: "low" } } */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * A prompting profile: how to detect a model, which prompt flags/delta it
 * wants, an optional standalone delegate template, and its recommended params.
 */
export interface Profile {
  /** Any regex matching → this profile. */
  match: RegExp[];
  /** Flag overrides layered over the neutral defaults. */
  flags: Partial<RenderFlags>;
  /** Appended into {{PROFILE_DELTA}}. */
  delta?: string;
  /** Whether the model accepts image inputs. Omitted means supported. */
  supportsImages?: boolean;
  /** Primary builder role uses this template instead of base. */
  primary?: string;
  /** Delegate role uses this template instead of base. */
  standalone?: string;
  params: ModelParams;
}

/**
 * Registry keyed by model family. Declaration order is resolution order:
 * `resolveProfile` returns the FIRST profile whose regex matches, so more
 * specific families (nano) precede their broader siblings (gpt-5.4).
 */
export const profiles = {
  "deepseek-v4-pro": {
    match: [/^deepseek-v4-pro\b/],
    flags: { planning: false, hallucinationGuard: true },
    delta: DEEPSEEK_DELTA,
    supportsImages: false,
    // DeepSeek vendor guidance: lower temps collapse the reasoning trace, so
    // hold sampling wide open.
    params: { temperature: 1.0, topP: 1.0 },
  },
  "gpt-5.4-nano": {
    match: [/^gpt-5\.4-nano\b/],
    flags: { planning: true, smallModel: true, subagentContract: true },
    standalone: STANDALONE_EXECUTOR,
    params: { providerOptions: { openai: { reasoningEffort: "low", textVerbosity: "low" } } },
  },
  "gpt-5.4": {
    // Negative lookahead keeps -nano out even if declaration order changed.
    match: [/^gpt-5\.4(?!-nano)\b/],
    flags: {},
    delta: GPT54_DELTA,
    params: { providerOptions: { openai: { reasoningEffort: "medium" } } },
  },
  "gpt-5.6-sol": {
    match: [/^gpt-5\.6-sol\b/],
    flags: { workflowSteps: false, workflowOutcome: true },
    params: { providerOptions: { openai: { reasoningEffort: "high", textVerbosity: "low" } } },
  },
  "gpt-5.6-terra": {
    // 5.6-family subtractive guidance (same outcome-first framing as sol), mid
    // tier. Deployed on the user's Azure resource.
    match: [/^gpt-5\.6-terra\b/],
    flags: { workflowSteps: false, workflowOutcome: true },
    params: { providerOptions: { openai: { reasoningEffort: "medium", textVerbosity: "low" } } },
  },
  "gpt-5.6-luna": {
    // Deployed on the user's Azure resource. Compact primary: per-step prompt
    // weight dominates cost at this tier (validated -19% tokens, eval 2026-07-16).
    match: [/^gpt-5\.6-luna\b/],
    flags: {},
    primary: COMPACT_PRIMARY,
    params: { providerOptions: { openai: { reasoningEffort: "low", textVerbosity: "low" } } },
  },
} satisfies Record<string, Profile>;

export type ProfileName = keyof typeof profiles;

export const profileNames = Object.keys(profiles) as [ProfileName, ...ProfileName[]];

/** First profile (declaration order) with any matching regex, else null. */
export function resolveProfile(model: string): ProfileName | null {
  for (const name of profileNames) {
    if (profiles[name].match.some((re) => re.test(model))) return name;
  }
  return null;
}
