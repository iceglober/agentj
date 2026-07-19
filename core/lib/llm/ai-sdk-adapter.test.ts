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

const { createAiSdkRuntime } = await import("./ai-sdk-adapter");

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
    expect(result.messages).toEqual([...history, { role: "user", content: prompt }, assistantTurn]);
  });

  test("compacts adapter-owned history into a fresh summary continuation", async () => {
    resetResult({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    nextResult.text = "User needs issue #24 implemented; context limit was crossed.";
    const history = [
      { role: "user", content: "implement it" },
      { role: "assistant", content: "working" },
    ];

    const compacted = await createAiSdkRuntime(config).compact(history);

    expect(generateCalls[0]?.messages).toEqual([
      ...history,
      {
        role: "user",
        content: "Create the handoff summary now. This replaces the prior conversation context.",
      },
    ]);
    expect(compacted).toEqual([
      {
        role: "user",
        content:
          "Conversation handoff summary follows. Continue from it as if you had the full history.",
      },
      { role: "assistant", content: nextResult.text },
    ]);
    expect(JSON.stringify(compacted)).not.toContain("implement it");
  });
});
