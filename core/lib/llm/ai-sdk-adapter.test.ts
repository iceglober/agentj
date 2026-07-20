import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { MetricMeasurement, MetricsSink } from "../metrics";
import type { GenerateRequest, LlmConfig, ToolSet } from "./index";

type AgentOptions = Record<string, unknown>;

const constructedAgents: AgentOptions[] = [];
const generateCalls: Record<string, unknown>[] = [];
const jsonSchemaCalls: unknown[] = [];
let nextResult: Record<string, unknown>;

class FakeToolLoopAgent {
  constructor(options: AgentOptions) {
    constructedAgents.push(options);
  }

  async generate(options: Record<string, unknown>) {
    generateCalls.push(options);
    return nextResult;
  }
}

mock.module("ai", () => ({
  ToolLoopAgent: FakeToolLoopAgent,
  jsonSchema: (schema: unknown) => {
    jsonSchemaCalls.push(schema);
    return { schema };
  },
  stepCountIs: (count: number) => ({ count }),
  tool: <T>(definition: T) => definition,
}));

const { createAiSdkRuntime, LLM_MAX_RETRIES } = await import("./ai-sdk-adapter");

const config = {
  provider: "azure",
  model: "test-model",
  providers: { azure: { apiKey: "test-api-key" } },
} as LlmConfig;
const secret = "azure-key-should-not-be-exported";
const path = "/private/project/path";
const prompt = `prompt containing ${secret} and ${path}`;
const output = `output containing ${secret} and ${path}`;
const toolError = `ERROR tool input ${secret} ${path}`;

function request(tools: ToolSet = {}): GenerateRequest {
  return { instructions: "stable instructions", prompt, tools };
}

function resetResult(usage: Record<string, unknown>) {
  constructedAgents.length = 0;
  generateCalls.length = 0;
  jsonSchemaCalls.length = 0;
  nextResult = { text: output, steps: [], usage };
}

describe("createAiSdkRuntime", () => {
  test("uses the bounded retry budget for transient model responses", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    await createAiSdkRuntime(config).generate(request());

    expect(constructedAgents[0]?.maxRetries).toBe(LLM_MAX_RETRIES);
    expect(LLM_MAX_RETRIES).toBe(5);
  });

  test("maps cache input details and preserves zero values", async () => {
    resetResult({
      inputTokens: 30,
      outputTokens: 4,
      totalTokens: 34,
      inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 20, cacheWriteTokens: 0 },
    });

    const result = await createAiSdkRuntime(config).generate(request());

    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 4,
      totalTokens: 34,
      noCacheInputTokens: 0,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 0,
    });
  });

  test("per-step usage carries cache input details for live cache-health UIs", async () => {
    resetResult({ inputTokens: 30, outputTokens: 4, totalTokens: 34 });
    nextResult.steps = [
      {
        toolCalls: [],
        toolResults: [],
        usage: {
          inputTokens: 100,
          outputTokens: 2,
          totalTokens: 102,
          inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 5 },
        },
      },
    ];

    const result = await createAiSdkRuntime(config).generate(request());

    expect(result.steps[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 2,
      totalTokens: 102,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 5,
    });
  });

  test("stopContextTokens installs a stop condition on step input tokens", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    await createAiSdkRuntime(config).generate({
      ...request(),
      stopSteps: 5,
      stopContextTokens: 1_000,
    });

    const stopWhen = constructedAgents[0]?.stopWhen as unknown[];
    expect(Array.isArray(stopWhen)).toBe(true);
    expect(stopWhen).toHaveLength(2);
    expect(stopWhen[0]).toEqual({ count: 5 });
    const condition = stopWhen[1] as (options: { steps: unknown[] }) => boolean;
    expect(condition({ steps: [{ usage: { inputTokens: 999 } }] })).toBe(false);
    expect(condition({ steps: [{ usage: { inputTokens: 1_000 } }] })).toBe(true);
    expect(condition({ steps: [{}] })).toBe(false);
    expect(condition({ steps: [] })).toBe(false);
  });

  test("without stop settings no stopWhen is installed", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    await createAiSdkRuntime(config).generate(request());

    expect(constructedAgents[0]).not.toHaveProperty("stopWhen");
  });

  test("falls back to zero aggregate usage without absent cache details", async () => {
    resetResult({});

    const result = await createAiSdkRuntime(config).generate(request());

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test("passes sorted toolOrder regardless of tool insertion order", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const tools = {
      zebra: { description: "z", inputSchema: z.object({}), execute: async () => "z" },
      alpha: { description: "a", inputSchema: z.object({}), execute: async () => "a" },
      middle: { description: "m", inputSchema: z.object({}), execute: async () => "m" },
    } as ToolSet;

    await createAiSdkRuntime(config).generate(request(tools));

    expect(constructedAgents).toHaveLength(1);
    expect(constructedAgents[0].toolOrder).toEqual(["alpha", "middle", "zebra"]);
    expect(Object.keys(constructedAgents[0].tools as object)).toEqual(["alpha", "middle", "zebra"]);
  });

  test("forces only the first step when the port requires a tool", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    await createAiSdkRuntime(config).generate({
      ...request({
        run_background_job: {
          description: "start",
          inputSchema: z.object({}),
          execute: async () => "",
        },
      }),
      requiredFirstTool: "run_background_job",
    });

    const prepareStep = constructedAgents[0]?.prepareStep as
      | ((context: { stepNumber: number }) => Record<string, unknown>)
      | undefined;
    expect(prepareStep).toBeDefined();
    expect(prepareStep?.({ stepNumber: 0 })).toEqual({
      activeTools: ["run_background_job"],
      toolChoice: { type: "tool", toolName: "run_background_job" },
    });
    expect(prepareStep?.({ stepNumber: 1 })).toEqual({});
  });

  test("maps provider-neutral JSON Schema through the AI SDK helper", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tools = {
      search: {
        description: "search",
        inputSchema: z.object({ query: z.string() }),
        jsonSchema: schema,
        execute: async () => "result",
      },
    } as ToolSet;

    await createAiSdkRuntime(config).generate(request(tools));

    expect(jsonSchemaCalls).toEqual([schema]);
    expect(
      (constructedAgents[0].tools as Record<string, { inputSchema: unknown }>).search.inputSchema,
    ).toEqual({ schema });
  });

  test("passes Zod schemas directly without invoking the JSON Schema helper", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const inputSchema = z.object({ query: z.string() });

    await createAiSdkRuntime(config).generate(
      request({ search: { description: "search", inputSchema, execute: async () => "result" } }),
    );

    expect(jsonSchemaCalls).toEqual([]);
    expect(
      (constructedAgents[0].tools as Record<string, { inputSchema: unknown }>).search.inputSchema,
    ).toBe(inputSchema);
  });

  test("marks structured nonzero command results as tool errors", async () => {
    resetResult({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    nextResult.steps = [
      {
        toolCalls: [{ toolName: "bash", input: { command: "bun add missing" } }],
        toolResults: [{ toolName: "bash", output: { exitCode: 1, stderr: "failed" } }],
      },
    ];

    const result = await createAiSdkRuntime(config).generate(request());
    expect(result.steps[0]?.toolResults[0]).toEqual({
      name: "bash",
      output: { exitCode: 1, stderr: "failed" },
      isError: true,
    });
  });

  test("records only aggregate metrics and contains a throwing sink", async () => {
    resetResult({
      inputTokens: 30,
      outputTokens: 4,
      totalTokens: 34,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 },
    });
    const measurements: MetricMeasurement[] = [];
    const sink: MetricsSink = {
      record(measurement) {
        measurements.push(measurement);
      },
    };

    const result = await createAiSdkRuntime(config, sink).generate(request());

    expect(result.text).toBe(output);
    expect(measurements.map(({ name }) => name).sort()).toEqual([
      "model.cache_read_ratio",
      "model.duration_ms",
      "model.tokens.cache_read",
      "model.tokens.cache_write",
      "model.tokens.input",
      "model.tokens.no_cache",
      "model.tokens.output",
      "model.tokens.total",
    ]);
    expect(
      measurements.every(({ attributes }) =>
        Object.keys(attributes).every((key) => ["provider", "model", "outcome"].includes(key)),
      ),
    ).toBe(true);
    expect(
      measurements.every(
        ({ attributes }) =>
          JSON.stringify(attributes) ===
          JSON.stringify({ provider: "azure", model: "test-model", outcome: "success" }),
      ),
    ).toBe(true);
    const exported = JSON.stringify(measurements);
    for (const value of [prompt, output, toolError, path, secret]) {
      expect(exported).not.toContain(value);
    }

    const throwingSink: MetricsSink = {
      record: () => {
        throw new Error(toolError);
      },
    };
    await expect(
      createAiSdkRuntime(config, throwingSink).generate(request()),
    ).resolves.toMatchObject({
      text: output,
    });
  });

  test("does not emit metrics when no sink is configured", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });

    await expect(createAiSdkRuntime(config).generate(request())).resolves.toMatchObject({
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect(generateCalls).toHaveLength(1);
  });

  test("fresh turns send prompt and return a continuation with the response messages", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const assistantTurn = { role: "assistant", content: "hi" };
    nextResult.response = { messages: [assistantTurn] };

    const result = await createAiSdkRuntime(config).generate(request());

    expect(generateCalls[0]).toMatchObject({ prompt });
    expect(generateCalls[0]).not.toHaveProperty("messages");
    expect(result.messages).toEqual([{ role: "user", content: prompt }, assistantTurn]);
  });

  test("sends image attachments as AI SDK file parts", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const image = { mediaType: "image/png" as const, data: "c2NyZWVuc2hvdA==" };

    const result = await createAiSdkRuntime(config).generate({ ...request(), images: [image] });

    const user = {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "file", ...image },
      ],
    };
    expect(generateCalls[0]).toEqual({ messages: [user] });
    expect(result.messages).toEqual([user]);
  });

  test("bounds tool outputs, preserves small objects, and spills oversized values", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const spilled: string[] = [];
    await createAiSdkRuntime(config).generate({
      ...request({
        external: {
          description: "external",
          inputSchema: z.object({}),
          execute: async () => ({ value: "x".repeat(100) }),
        },
      }),
      maxOutputChars: 20,
      spill: (label, value) => {
        spilled.push(`${label}:${value.length}`);
        return "/spill/full.json";
      },
    });
    const agent = constructedAgents[0];
    if (!agent) throw new Error("agent was not constructed");
    const execute = (agent.tools as Record<string, { execute: () => Promise<unknown> }>).external
      .execute;
    const result = await execute();
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeLessThanOrEqual(20);
    expect(spilled).toEqual(["tool-output:112"]);
  });

  test("sanitizes oversized tool results in resumed history", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const history = [{ role: "tool", content: [{ type: "tool-result", output: "x".repeat(100) }] }];
    await createAiSdkRuntime(config).generate({
      ...request(),
      messages: history,
      maxOutputChars: 20,
    });
    const messages = generateCalls[0]?.messages as unknown[];
    const output = (messages[0] as { content: { output: string }[] }).content[0].output;
    expect(output.length).toBeLessThanOrEqual(20);
  });

  test("continued turns send prior messages plus the prompt as the next user message", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const history = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ];
    const assistantTurn = { role: "assistant", content: "again" };
    nextResult.response = { messages: [assistantTurn] };

    const result = await createAiSdkRuntime(config).generate({
      ...request(),
      messages: history,
    });

    expect(generateCalls[0]).not.toHaveProperty("prompt");
    expect(generateCalls[0]?.messages).toEqual([...history, { role: "user", content: prompt }]);
    // Instructions are installed on every freshly constructed SDK agent, not
    // folded into adapter-owned continuation history.
    expect(constructedAgents[0]?.instructions).toBe("stable instructions");
    expect(result.messages).toEqual([...history, { role: "user", content: prompt }, assistantTurn]);
  });
});
