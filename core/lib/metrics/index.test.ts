import { describe, expect, test } from "bun:test";

import {
  type MetricMeasurement,
  type MetricsSink,
  noopMetricsSink,
  recordModelUsage,
  sanitizeMetricAttributes,
} from "./index";

function createFakeSink(): { sink: MetricsSink; measurements: MetricMeasurement[] } {
  const measurements: MetricMeasurement[] = [];
  return {
    measurements,
    sink: { record: (measurement) => measurements.push(measurement) },
  };
}

const attributes = {
  provider: "azure",
  model: "gpt-4o-mini",
  outcome: "success",
};

describe("metrics port", () => {
  test("sanitizes attributes to the approved low-cardinality keys", () => {
    expect(sanitizeMetricAttributes(attributes)).toEqual(attributes);
    expect(sanitizeMetricAttributes({ ...attributes, unapprovedField: "value" })).toBeUndefined();
    expect(sanitizeMetricAttributes({ ...attributes, model: "contains spaces" })).toBeUndefined();
    expect(sanitizeMetricAttributes({ provider: "azure", model: "gpt-4o-mini" })).toBeUndefined();

    const { sink, measurements } = createFakeSink();
    recordModelUsage(sink, { ...attributes, unapprovedField: "value" }, { durationMs: 1 });
    expect(measurements).toEqual([]);
  });

  test("records cache-aware token measurements and cache-read ratio", () => {
    const { sink, measurements } = createFakeSink();

    recordModelUsage(sink, attributes, {
      durationMs: 25,
      inputTokens: 100,
      noCacheTokens: 60,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      outputTokens: 30,
      totalTokens: 130,
    });

    expect(measurements.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "model.duration_ms", value: 25 },
      { name: "model.tokens.input", value: 100 },
      { name: "model.tokens.no_cache", value: 60 },
      { name: "model.tokens.cache_read", value: 40 },
      { name: "model.tokens.cache_write", value: 5 },
      { name: "model.tokens.output", value: 30 },
      { name: "model.tokens.total", value: 130 },
      { name: "model.cache_read_ratio", value: 0.4 },
    ]);
    expect(
      measurements.every((measurement) => measurement.attributes.provider === "azure"),
    ).toBeTrue();
    expect(
      measurements.every((measurement) => measurement.attributes.model === "gpt-4o-mini"),
    ).toBeTrue();
    expect(
      measurements.every((measurement) => measurement.attributes.outcome === "success"),
    ).toBeTrue();
  });

  test("omits cache-read ratio when its inputs are absent or unsafe", () => {
    const { sink, measurements } = createFakeSink();

    recordModelUsage(sink, attributes, { durationMs: 1, inputTokens: 0, cacheReadTokens: 0 });
    recordModelUsage(sink, attributes, { durationMs: 1, inputTokens: 10 });
    recordModelUsage(sink, attributes, {
      durationMs: 1,
      inputTokens: 10,
      cacheReadTokens: Number.NaN,
    });

    expect(measurements.filter(({ name }) => name === "model.cache_read_ratio")).toEqual([]);
  });

  test("is a no-op without a configured sink", () => {
    expect(() => recordModelUsage(undefined, attributes, { durationMs: 1 })).not.toThrow();
    expect(() =>
      noopMetricsSink.record({ name: "model.duration_ms", value: 1, attributes }),
    ).not.toThrow();
  });

  test("omits invalid numeric measurements without blocking valid ones", () => {
    const { sink, measurements } = createFakeSink();

    recordModelUsage(sink, attributes, {
      durationMs: Number.POSITIVE_INFINITY,
      inputTokens: -1,
      noCacheTokens: Number.NaN,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      outputTokens: 3,
      totalTokens: 5,
    });

    expect(measurements.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "model.tokens.cache_read", value: 2 },
      { name: "model.tokens.cache_write", value: 0 },
      { name: "model.tokens.output", value: 3 },
      { name: "model.tokens.total", value: 5 },
    ]);
  });

  test("swallows sink errors so telemetry cannot fail a task", () => {
    const sink: MetricsSink = {
      record: () => {
        throw new Error("sink failed");
      },
    };

    expect(() =>
      recordModelUsage(sink, attributes, { durationMs: 1, inputTokens: 1 }),
    ).not.toThrow();
  });
});
