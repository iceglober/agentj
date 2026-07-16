import {
  type ToolSet as AiToolSet,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import { type MetricsSink, recordModelUsage } from "../metrics";
import { type AzureModelConfig, createAzureModelProvider } from "./azure-adapter";
import type {
  AgentRuntime,
  GenerateRequest,
  LlmConfig,
  RunResult,
  RunStep,
  TokenUsage,
  ToolDef,
  ToolSet,
} from "./index";

/** A model constructor bound to one provider's auth; adapters return these. */
export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * Per-provider connection/auth settings. Every provider needs its own props
 * (azure: resourceName; vertex: project/location; ...), so each vendor-auth
 * adapter exports its own schema and gets a block here.
 */
export interface ProviderConfigs {
  azure: AzureModelConfig;
}

export type ProviderName = keyof ProviderConfigs;

/** Registry keyed by config value (`llm.provider`). Internal to this adapter. */
const llmProviders: {
  [K in ProviderName]: (config?: ProviderConfigs[K]) => ModelFactory;
} = {
  azure: createAzureModelProvider,
};

/** Provider names, exported so the port schema derives its enum from here. */
export const providerNames = Object.keys(llmProviders) as [ProviderName, ...ProviderName[]];

const createModel = (config: LlmConfig): LanguageModel => {
  // The mapped registry ties each key to its own config type; indexing with a
  // union key erases that link, so re-assert it here — the shape is enforced
  // where it matters, on the registry itself.
  const provider = llmProviders[config.provider] as (
    c?: ProviderConfigs[ProviderName],
  ) => ModelFactory;
  return provider(config.providers?.[config.provider])(config.model);
};

/** Minimal structural view of an ai StepResult; decouples us from ai generics. */
interface AiStepLike {
  toolCalls: readonly { toolName: string; input: unknown }[];
  toolResults: readonly { toolName: string; output?: unknown }[];
}

const mapStep = (step: AiStepLike): RunStep => ({
  toolCalls: step.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
  toolResults: step.toolResults.map((tr) => {
    const output = tr.output;
    return {
      name: tr.toolName,
      output,
      isError:
        (typeof output === "string" && output.startsWith("ERROR")) ||
        (typeof output === "object" &&
          output !== null &&
          ((typeof (output as Record<string, unknown>).exitCode === "number" &&
            (output as Record<string, unknown>).exitCode !== 0) ||
            (output as Record<string, unknown>).success === false ||
            (output as Record<string, unknown>).error != null)),
    };
  }),
});

/** Wrap one ToolDef as an ai `tool()`, forwarding call options verbatim. */
const toAiTool = (def: ToolDef) =>
  tool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: (input, options) => def.execute(input, options),
  });

const mapTools = (tools: ToolSet): AiToolSet =>
  Object.fromEntries(
    Object.keys(tools)
      .sort()
      .map((name) => [name, toAiTool(tools[name])]),
  ) as AiToolSet;

/**
 * The AI SDK runtime: a ToolLoopAgent per generate() call (instructions and
 * call settings are per-request), driving the model this factory bound once.
 * The ToolLoopAgent constructor (ai@7) extends LanguageModelCallOptions, so
 * temperature/topP/providerOptions/stopWhen are constructor-level, while
 * abortSignal/onStepFinish are generate()-level.
 */
export const createAiSdkRuntime = (config: LlmConfig, metricsSink?: MetricsSink): AgentRuntime => {
  const model = createModel(config);

  return {
    async generate(req: GenerateRequest): Promise<RunResult> {
      const startedAt = Date.now();
      const recordUsage = (outcome: "success" | "error", usage?: TokenUsage) => {
        try {
          recordModelUsage(
            metricsSink,
            { provider: config.provider, model: config.model, outcome },
            {
              durationMs: Date.now() - startedAt,
              inputTokens: usage?.inputTokens,
              noCacheTokens: usage?.noCacheInputTokens,
              cacheReadTokens: usage?.cacheReadInputTokens,
              cacheWriteTokens: usage?.cacheWriteInputTokens,
              outputTokens: usage?.outputTokens,
              totalTokens: usage?.totalTokens,
            },
          );
        } catch {
          // Metrics are observational and must never affect generation.
        }
      };

      try {
        const agent = new ToolLoopAgent({
          model,
          instructions: req.instructions,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.topP !== undefined ? { topP: req.topP } : {}),
          // Our providerOptions is Record<string, Record<string, unknown>>; the
          // SDK wants JSON-valued options. It is passed through verbatim, so cast
          // at this vendor boundary rather than narrowing the port's shape.
          ...(req.providerOptions
            ? {
                providerOptions: req.providerOptions as Record<string, Record<string, never>>,
              }
            : {}),
          ...(req.stopSteps !== undefined ? { stopWhen: stepCountIs(req.stopSteps) } : {}),
          toolOrder: Object.keys(req.tools).sort(),
          tools: mapTools(req.tools),
        });

        const onStep = req.onStep;
        // Continuation: prior turns (opaque vendor messages) plus this turn's
        // prompt as the next user message; fresh turns send prompt alone.
        const inputMessages = req.messages
          ? [...req.messages, { role: "user" as const, content: req.prompt }]
          : undefined;
        // The continuation is opaque at the port; this vendor boundary is the
        // one place that re-asserts its true shape (same idiom as providerOptions).
        const result = await agent.generate({
          ...(inputMessages
            ? { messages: inputMessages as ModelMessage[] }
            : { prompt: req.prompt }),
          ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
          ...(onStep ? { onStepFinish: (step) => onStep(mapStep(step)) } : {}),
        });

        const usage = (result as { totalUsage?: typeof result.usage }).totalUsage ?? result.usage;
        const inputTokenDetails = usage.inputTokenDetails as
          | {
              noCacheTokens?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            }
          | undefined;
        const mappedUsage: TokenUsage = {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
          ...(inputTokenDetails?.noCacheTokens !== undefined
            ? { noCacheInputTokens: inputTokenDetails.noCacheTokens }
            : {}),
          ...(inputTokenDetails?.cacheReadTokens !== undefined
            ? { cacheReadInputTokens: inputTokenDetails.cacheReadTokens }
            : {}),
          ...(inputTokenDetails?.cacheWriteTokens !== undefined
            ? { cacheWriteInputTokens: inputTokenDetails.cacheWriteTokens }
            : {}),
        };
        recordUsage("success", mappedUsage);
        const finishReason = (result as { finishReason?: string }).finishReason;
        const stepLimit = req.stopSteps ?? 20;
        const responseMessages =
          (result as { response?: { messages?: unknown[] } }).response?.messages ?? [];
        return {
          text: result.text,
          steps: result.steps.map(mapStep),
          usage: mappedUsage,
          messages: [
            ...(inputMessages ?? [{ role: "user", content: req.prompt }]),
            ...responseMessages,
          ],
          ...(finishReason ? { finishReason } : {}),
          ...(result.steps.length >= stepLimit && result.text.trim() === ""
            ? { stepLimitReached: true }
            : {}),
        };
      } catch (error) {
        recordUsage("error");
        throw error;
      }
    },
  };
};
