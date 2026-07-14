import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { MetricMeasurement, MetricsSink } from "../metrics";
import type { GenerateRequest, LlmConfig, ToolSet } from "./index";

type AgentOptions = Record<string, unknown>;

const constructedAgents: AgentOptions[] = [];
const generateCalls: Record<string, unknown>[] = [];
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
    expect(Object.keys(constructedAgents[0].tools as object)).toEqual([
      "alpha",
      "middle",
      "zebra",
    ]);
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
    expect(measurements.every(({ attributes }) =>
      Object.keys(attributes).every((key) => ["provider", "model", "outcome"].includes(key)),
    )).toBe(true);
    expect(measurements.every(({ attributes }) =>
      JSON.stringify(attributes) === JSON.stringify({ provider: "azure", model: "test-model", outcome: "success" }),
    )).toBe(true);
    const exported = JSON.stringify(measurements);
    for (const value of [prompt, output, toolError, path, secret]) {
      expect(exported).not.toContain(value);
    }

    const throwingSink: MetricsSink = { record: () => { throw new Error(toolError); } };
    await expect(createAiSdkRuntime(config, throwingSink).generate(request())).resolves.toMatchObject({
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
});
