import {
  type ToolSet as AiToolSet,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import { type MetricsSink, recordModelUsage } from "../metrics";
import { truncateUnknownWithSpill } from "../truncation";
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

/** Maximum retries for retryable model responses such as rate limits and 5xx errors. */
export const LLM_MAX_RETRIES = 5;

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

const mapStepUsage = (step: AiStepLike): { usage?: RunStep["usage"] } => {
  const usage = (
    step as {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        inputTokenDetails?: {
          noCacheTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
    }
  ).usage;
  if (!usage) return {};
  const details = usage.inputTokenDetails;
  return {
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      ...(details?.noCacheTokens !== undefined
        ? { noCacheInputTokens: details.noCacheTokens }
        : {}),
      ...(details?.cacheReadTokens !== undefined
        ? { cacheReadInputTokens: details.cacheReadTokens }
        : {}),
      ...(details?.cacheWriteTokens !== undefined
        ? { cacheWriteInputTokens: details.cacheWriteTokens }
        : {}),
    },
  };
};

const boundOutput = (
  value: unknown,
  req: Pick<GenerateRequest, "maxOutputChars" | "spill">,
  label: string,
): unknown =>
  req.maxOutputChars === undefined
    ? value
    : truncateUnknownWithSpill(value, req.maxOutputChars, req.spill, label);

const sanitizeHistory = (messages: unknown[], req: GenerateRequest): unknown[] =>
  messages.map((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "tool"
    ) {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    return {
      ...(message as Record<string, unknown>),
      content: content.map((part, index) => {
        if (!part || typeof part !== "object") return part;
        const record = part as Record<string, unknown>;
        const outputKey = "output" in record ? "output" : "result" in record ? "result" : undefined;
        return outputKey
          ? { ...record, [outputKey]: boundOutput(record[outputKey], req, `history-tool-${index}`) }
          : part;
      }),
    };
  });

const mapStep = (step: AiStepLike, req?: GenerateRequest): RunStep => ({
  ...mapStepUsage(step),
  toolCalls: step.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
  toolResults: step.toolResults.map((tr) => {
    const output = req ? boundOutput(tr.output, req, `tool-${tr.toolName}`) : tr.output;
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

/**
 * Stop once the latest step's request context reached the token ceiling. The
 * SDK's StopCondition is generic over the toolset; the check only touches
 * step usage, so the structural type is asserted at this vendor boundary.
 */
const contextTokensAtLeast = (limit: number) =>
  (({ steps }: { steps: ReadonlyArray<{ usage?: { inputTokens?: number } }> }) => {
    const inputTokens = steps.at(-1)?.usage?.inputTokens;
    return inputTokens !== undefined && inputTokens >= limit;
  }) as unknown as ReturnType<typeof stepCountIs>;

const stopConditions = (req: GenerateRequest): ReturnType<typeof stepCountIs>[] => [
  ...(req.stopSteps !== undefined ? [stepCountIs(req.stopSteps)] : []),
  ...(req.stopContextTokens !== undefined ? [contextTokensAtLeast(req.stopContextTokens)] : []),
];

/** Wrap one ToolDef as an ai `tool()`, forwarding call options verbatim. */
const toAiTool = (def: ToolDef, req: Pick<GenerateRequest, "maxOutputChars" | "spill">) =>
  tool({
    description: def.description,
    inputSchema:
      def.jsonSchema !== undefined
        ? jsonSchema(def.jsonSchema as Parameters<typeof jsonSchema>[0])
        : def.inputSchema,
    execute: async (input, options) => {
      try {
        const output = await def.execute(input, options);
        return boundOutput(output, req, "tool-output");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const bounded = boundOutput(`ERROR: ${message}`, req, "tool-error");
        throw new Error(typeof bounded === "string" ? bounded : String(bounded));
      }
    },
  });

const mapTools = (tools: ToolSet, req: GenerateRequest): AiToolSet =>
  Object.fromEntries(
    Object.keys(tools)
      .sort()
      .map((name) => [name, toAiTool(tools[name], req)]),
  ) as AiToolSet;

const userMessage = (req: GenerateRequest): ModelMessage =>
  req.images && req.images.length > 0
    ? {
        role: "user",
        content: [
          { type: "text", text: req.prompt },
          ...req.images.map((image) => ({
            type: "file" as const,
            mediaType: image.mediaType,
            data: image.data,
          })),
        ],
      }
    : { role: "user", content: req.prompt };

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
        const requiredFirstTool = req.requiredFirstTool;
        const agent = new ToolLoopAgent({
          model,
          instructions: req.instructions,
          maxRetries: LLM_MAX_RETRIES,
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
          ...(stopConditions(req).length > 0 ? { stopWhen: stopConditions(req) } : {}),
          toolOrder: Object.keys(req.tools).sort(),
          tools: mapTools(req.tools, req),
          ...(requiredFirstTool
            ? {
                prepareStep: ({ stepNumber }: { stepNumber: number }) =>
                  stepNumber === 0
                    ? {
                        activeTools: [requiredFirstTool],
                        toolChoice: { type: "tool" as const, toolName: requiredFirstTool },
                      }
                    : {},
              }
            : {}),
        });

        const onStep = req.onStep;
        // Continuation: prior turns (opaque vendor messages) plus this turn's
        // prompt as the next user message; fresh turns send prompt alone.
        const input = userMessage(req);
        const inputMessages = req.messages
          ? [...sanitizeHistory(req.messages, req), input]
          : undefined;
        // The continuation is opaque at the port; this vendor boundary is the
        // one place that re-asserts its true shape (same idiom as providerOptions).
        const result = await agent.generate({
          ...(inputMessages
            ? { messages: inputMessages as ModelMessage[] }
            : req.images && req.images.length > 0
              ? { messages: [input] }
              : { prompt: req.prompt }),
          ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
          ...(onStep ? { onStepFinish: (step) => onStep(mapStep(step, req)) } : {}),
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
          steps: result.steps.map((step) => mapStep(step, req)),
          usage: mappedUsage,
          messages: sanitizeHistory([...(inputMessages ?? [input]), ...responseMessages], req),
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
