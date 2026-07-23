import { describe, expect, mock, test } from "bun:test";
import type { Counter, Histogram } from "@opentelemetry/api";

import type { MetricAttributes, MetricMeasurement } from "./index";
import { createOtelMetricsSink } from "./otel-adapter";

const safeAttributes: MetricAttributes = {
  provider: "azure",
  model: "gpt-4.1-mini",
  outcome: "success",
};

const sensitiveValues = [
  "prompt-fixture-must-not-export",
  "output-fixture-must-not-export",
  "tool-fixture-must-not-export",
  "error-fixture-must-not-export",
  "/private/project/path-fixture-must-not-export",
];

interface InstrumentCall {
  readonly name: string;
  readonly unit: string | undefined;
  readonly value: number;
  readonly attributes: unknown;
}

function createFakeMeter(options: { throwOnAdd?: boolean } = {}) {
  const counters: InstrumentCall[] = [];
  const histograms: InstrumentCall[] = [];
  const created: Array<{
    readonly kind: "counter" | "histogram";
    readonly name: string;
    readonly unit: string | undefined;
  }> = [];
  const add = mock((name: string, unit: string | undefined, value: number, attributes: unknown) => {
    if (options.throwOnAdd) throw new Error("instrument failure");
    counters.push({ name, unit, value, attributes });
  });
  const record = mock(
    (name: string, unit: string | undefined, value: number, attributes: unknown) => {
      histograms.push({ name, unit, value, attributes });
    },
  );
  const meter = {
    createCounter: mock((name: string, instrumentOptions?: { unit?: string }) => {
      created.push({ kind: "counter", name, unit: instrumentOptions?.unit });
      return {
        add: (value: number, attributes: unknown) =>
          add(name, instrumentOptions?.unit, value, attributes),
      } as Counter;
    }),
    createHistogram: mock((name: string, instrumentOptions?: { unit?: string }) => {
      created.push({ kind: "histogram", name, unit: instrumentOptions?.unit });
      return {
        record: (value: number, attributes: unknown) =>
          record(name, instrumentOptions?.unit, value, attributes),
      } as Histogram;
    }),
  };

  return { add, counters, created, histograms, meter, record };
}

describe("createOtelMetricsSink", () => {
  test("does not resolve a meter when telemetry is disabled", () => {
    const getMeter = mock(() => {
      throw new Error("Disabled telemetry must not resolve a meter");
    });

    expect(() =>
      createOtelMetricsSink({ enabled: false, metricsApi: { getMeter } as never }).record({
        name: "model.tokens.input",
        value: 1,
        attributes: safeAttributes,
      }),
    ).not.toThrow();
    expect(getMeter).not.toHaveBeenCalled();
  });

  test("creates the exact aggregate instruments and records token and cache metrics with safe attributes", () => {
    const fake = createFakeMeter();
    const getMeter = mock(() => fake.meter);
    const sink = createOtelMetricsSink({ enabled: true, metricsApi: { getMeter } as never });

    expect(getMeter).toHaveBeenCalledWith("glorious");
    expect(fake.created).toEqual([
      { kind: "histogram", name: "glorious.llm.duration", unit: "ms" },
      { kind: "counter", name: "glorious.llm.tokens.input", unit: "tokens" },
      { kind: "counter", name: "glorious.llm.tokens.no_cache", unit: "tokens" },
      { kind: "counter", name: "glorious.llm.tokens.cache_read", unit: "tokens" },
      { kind: "counter", name: "glorious.llm.tokens.cache_write", unit: "tokens" },
      { kind: "counter", name: "glorious.llm.tokens.output", unit: "tokens" },
      { kind: "counter", name: "glorious.llm.tokens.total", unit: "tokens" },
      { kind: "histogram", name: "glorious.llm.cache_read_ratio", unit: "1" },
    ]);

    for (const measurement of [
      { name: "model.tokens.input", value: 100 },
      { name: "model.tokens.cache_read", value: 80 },
      { name: "model.tokens.cache_write", value: 5 },
      { name: "model.tokens.total", value: 120 },
      { name: "model.cache_read_ratio", value: 0.8 },
    ] as const) {
      sink.record({ ...measurement, attributes: safeAttributes });
    }

    expect(fake.counters).toEqual([
      { name: "glorious.llm.tokens.input", unit: "tokens", value: 100, attributes: safeAttributes },
      {
        name: "glorious.llm.tokens.cache_read",
        unit: "tokens",
        value: 80,
        attributes: safeAttributes,
      },
      {
        name: "glorious.llm.tokens.cache_write",
        unit: "tokens",
        value: 5,
        attributes: safeAttributes,
      },
      { name: "glorious.llm.tokens.total", unit: "tokens", value: 120, attributes: safeAttributes },
    ]);
    expect(fake.histograms).toEqual([
      { name: "glorious.llm.cache_read_ratio", unit: "1", value: 0.8, attributes: safeAttributes },
    ]);
    for (const call of [...fake.counters, ...fake.histograms]) {
      expect(call.attributes).toEqual(safeAttributes);
      for (const sensitiveValue of sensitiveValues) {
        expect(JSON.stringify(call.attributes)).not.toContain(sensitiveValue);
      }
    }
  });

  test("does not record invalid values or content-bearing attributes", () => {
    const fake = createFakeMeter();
    const sink = createOtelMetricsSink({ enabled: true, meterFactory: () => fake.meter });
    const contentAttributes = {
      ...safeAttributes,
      prompt: sensitiveValues[0],
      output: sensitiveValues[1],
      tool: sensitiveValues[2],
      error: sensitiveValues[3],
      path: sensitiveValues[4],
    } as unknown as MetricAttributes;

    sink.record({ name: "model.tokens.input", value: Number.NaN, attributes: safeAttributes });
    sink.record({ name: "model.tokens.input", value: -1, attributes: safeAttributes });
    sink.record({ name: "model.tokens.input", value: 1, attributes: contentAttributes });

    expect(fake.counters).toEqual([]);
    expect(fake.histograms).toEqual([]);
  });

  test("contains meter construction errors and instrument errors disable later recording", () => {
    const getMeter = mock(() => {
      throw new Error("meter failure");
    });
    const unavailableSink = createOtelMetricsSink({
      enabled: true,
      metricsApi: { getMeter } as never,
    });
    expect(() =>
      unavailableSink.record({ name: "model.tokens.input", value: 1, attributes: safeAttributes }),
    ).not.toThrow();

    const fake = createFakeMeter({ throwOnAdd: true });
    const sink = createOtelMetricsSink({ enabled: true, meterFactory: () => fake.meter });
    const measurement: MetricMeasurement = {
      name: "model.tokens.input",
      value: 1,
      attributes: safeAttributes,
    };

    expect(() => sink.record(measurement)).not.toThrow();
    expect(() => sink.record(measurement)).not.toThrow();
    expect(fake.add).toHaveBeenCalledTimes(1);
  });
});
