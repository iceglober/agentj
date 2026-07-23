import z from "zod";
import type { MetricsSink } from "../metrics";
import type { SpillWriter } from "../truncation";
import { createAiSdkRuntime, providerNames } from "./ai-sdk-adapter";
import { azureModelConfigSchema } from "./azure-adapter";

export { providerNames };

/**
 * A tool the agent can call. Our own vendor-free shape, structurally close to
 * the AI SDK's `tool()` on purpose so the ai-sdk adapter maps it 1:1.
 *
 * `execute` returns `unknown`, not `string`: our own tools return strings, but
 * vendor tool providers (bash-tool) return structured objects, and both must
 * survive the round trip through this shape. The optional second arg is opaque
 * call metadata (toolCallId/messages/abortSignal) forwarded verbatim by the
 * adapter, so a vendor tool that reads it still works.
 */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  description: string;
  inputSchema: S;
  /** Provider-neutral JSON Schema override for runtimes that support it. */
  jsonSchema?: Record<string, unknown>;
  execute: (input: z.infer<S>, options?: unknown) => Promise<unknown> | unknown;
}

/** Inference helper replacing ai's `tool()`; keeps `input` typed from the schema. */
export const defineTool = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t;

/** A named set of tools handed to the runtime. */
export type ToolSet = Record<string, ToolDef>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input tokens sent without a provider prompt-cache hit. */
  noCacheInputTokens?: number;
  /** Input tokens served from the provider prompt cache. */
  cacheReadInputTokens?: number;
  /** Input tokens written to the provider prompt cache. */
  cacheWriteInputTokens?: number;
}

export interface RunStep {
  toolCalls: { name: string; input: unknown }[];
  toolResults: { name: string; output: unknown; isError?: boolean }[];
  /** This step's request usage: inputTokens is the request's full context
   *  size, so live UIs can show both cumulative spend and current window. */
  usage?: TokenUsage;
}

export interface RunResult {
  text: string;
  steps: RunStep[];
  usage: TokenUsage;
  finishReason?: string;
  stepLimitReached?: boolean;
  /**
   * Opaque continuation: the full vendor message history after this turn
   * (input messages + this turn's). Feed back via GenerateRequest.messages to
   * continue the conversation with tool-call memory intact. Only the adapter
   * knows the element shape; callers store/pass it verbatim. Optional so
   * non-chat fakes need not fabricate it; real adapters always populate it.
   */
  messages?: unknown[];
}

export interface ImageAttachment {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64-encoded image bytes. */
  data: string;
}

export interface GenerateRequest {
  instructions: string;
  prompt: string;
  /** Images sent with this user message. */
  images?: readonly ImageAttachment[];
  /** Prior turns (RunResult.messages). When present, `prompt` is appended as
   *  the next user message; when absent, the turn starts fresh from `prompt`. */
  messages?: unknown[];
  tools: ToolSet;
  /** Require this tool on the first model step. The adapter maps this
   * provider-neutral intent to its own tool-choice API. */
  requiredFirstTool?: string;
  temperature?: number;
  topP?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Cap all model-bound tool output, including opaque continuation history. */
  maxOutputChars?: number;
  /** Persist full output when the model-bound value is capped. */
  spill?: SpillWriter;
  /** Cap the tool loop at N steps; omitted → the runtime's default. */
  stopSteps?: number;
  /**
   * Stop the tool loop once a step's request context reaches this many input
   * tokens — the fresh-context analogue of a soft context limit: children
   * can't receive turn notices, so they stop instead of warning. Omitted → no
   * token ceiling.
   */
  stopContextTokens?: number;
  abortSignal?: AbortSignal;
  onStep?: (step: RunStep) => void;
}

/**
 * The runtime port: the LLM external system is model + generation loop behind
 * one boundary. `generate` runs a full tool loop and returns a vendor-free
 * result. Adapters (ai-sdk-adapter.ts) own the SDK.
 */
export interface AgentRuntime {
  generate(req: GenerateRequest): Promise<RunResult>;
}

/**
 * Runtime names, the source of truth the config enum derives from. Kept as a
 * literal tuple (rather than `keyof typeof runtimes`) so the schema type does
 * not depend on the registry values — those reference `LlmConfig`, which the
 * schema defines, and closing that loop would make the whole config `any`.
 */
const runtimeNames = ["ai-sdk"] as const;
export type RuntimeName = (typeof runtimeNames)[number];

/**
 * Model variant — for the reasoning-model families this is the reasoning
 * effort, forwarded as `providerOptions.openai.reasoningEffort`. The set is
 * what the provider accepts; a model's profile supplies the default.
 */
export const MODEL_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelVariant = (typeof MODEL_VARIANTS)[number];
export const modelVariantSchema = z.enum(MODEL_VARIANTS);

/**
 * Serializable model selection; the `llm.*` section of the agent config.
 *
 * Auth and provider props are config-first with env fallback: explicit values
 * in `providers.{name}` win, otherwise each adapter falls back to its
 * documented env vars and throws early if a required one is missing.
 */
export const llmConfigSchema = z.object({
  /** Which generation runtime to drive the model + tool loop with. */
  runtime: z.enum(runtimeNames).default("ai-sdk"),
  provider: z.enum(providerNames).default("azure"),
  model: z.string().default("gpt-5.6-luna"),
  /**
   * Ordered, provider-agnostic model ladder: index 0 is the frontier tier
   * (most capable, most expensive), each later entry a cheaper rung. Routing
   * config (mode routing, subagent tier) references indices into this ladder,
   * never model ids, so swapping providers means swapping one array. Empty →
   * every tier resolves to `model`.
   */
  tiers: z.array(z.string().min(1)).default([]),
  /**
   * Per-tier model variant (reasoning effort), aligned index-for-index with
   * `tiers`. An unset tier falls back to the model profile's default variant,
   * so this only records deliberate overrides.
   */
  variants: z.array(modelVariantSchema).default([]),
  /**
   * Which ladder tier each chat mode runs on. Plan defaults to the frontier
   * tier: planning is the highest-leverage phase of an agentic workstream.
   */
  modes: z
    .object({
      plan: z.number().int().min(0).default(0),
      build: z.number().int().min(0).default(1),
    })
    .prefault({}),
  /** Call setting; forward to the agent/generate call, not the model. */
  temperature: z.number().min(0).max(2).optional(),
  /** Call setting; nucleus sampling (0–1). Forwarded like temperature. */
  topP: z.number().min(0).max(1).optional(),
  providers: z
    .object({
      azure: azureModelConfigSchema.optional(),
    })
    .optional(),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

/**
 * Resolve a tier index against the ladder. Out-of-range indices clamp to the
 * cheapest rung, so routing config written for a deep ladder stays valid on a
 * shallow one; an empty ladder resolves every tier to `model`.
 */
export const resolveTierModel = (llm: LlmConfig, tier: number): string => {
  const last = llm.tiers.length - 1;
  return last < 0 ? llm.model : (llm.tiers[Math.min(Math.max(tier, 0), last)] as string);
};

/**
 * The explicit variant override for a tier, or undefined when none is set (the
 * caller then uses the model profile's default). Unlike the model ladder this
 * does not clamp: an unset index means "no override", not "inherit a sibling".
 */
export const resolveTierVariant = (llm: LlmConfig, tier: number): ModelVariant | undefined =>
  llm.variants[Math.max(tier, 0)];

/**
 * Registry keyed by config value (`llm.runtime`); same idiom as editModes. The
 * `satisfies` clause ties each key to a runtime factory and fails the build if
 * a name in `runtimeNames` has no entry (or vice versa).
 */
export const runtimes = {
  "ai-sdk": createAiSdkRuntime,
} satisfies Record<RuntimeName, (config: LlmConfig, metricsSink?: MetricsSink) => AgentRuntime>;

/** The port's factory: pick the runtime by config and hand back the boundary. */
export const createRuntime = (config: LlmConfig, metricsSink?: MetricsSink): AgentRuntime =>
  runtimes[config.runtime](config, metricsSink);
