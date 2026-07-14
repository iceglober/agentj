import z from "zod";
import type { MetricsSink } from "../metrics";
import { createAiSdkRuntime, providerNames } from "./ai-sdk-adapter";
import { azureModelConfigSchema } from "./azure-adapter";

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
}

export interface RunResult {
  text: string;
  steps: RunStep[];
  usage: TokenUsage;
}

export interface GenerateRequest {
  instructions: string;
  prompt: string;
  tools: ToolSet;
  temperature?: number;
  topP?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Cap the tool loop at N steps; omitted → the runtime's default. */
  stopSteps?: number;
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
  model: z.string().default("gpt-5.6-sol"),
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
