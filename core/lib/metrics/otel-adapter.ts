import type { Counter, Histogram, Meter } from "@opentelemetry/api";
import { metrics } from "@opentelemetry/api";

import {
  type MetricMeasurement,
  type MetricsSink,
  noopMetricsSink,
  sanitizeMetricAttributes,
} from "./index";

type OtelMeter = Pick<Meter, "createCounter" | "createHistogram">;

export interface OtelMetricsSinkOptions {
  enabled?: boolean;
  metricsApi?: Pick<typeof metrics, "getMeter">;
  meterFactory?: () => OtelMeter;
}

interface OtelInstruments {
  duration: Histogram;
  inputTokens: Counter;
  longContextInputTokens: Counter;
  noCacheTokens: Counter;
  cacheReadTokens: Counter;
  cacheWriteTokens: Counter;
  outputTokens: Counter;
  totalTokens: Counter;
  cacheReadRatio: Histogram;
}

const instrumentOptions = {
  duration: { unit: "ms" },
  tokens: { unit: "tokens" },
  ratio: { unit: "1" },
} as const;

export function createOtelMetricsSink(options: OtelMetricsSinkOptions = {}): MetricsSink {
  if (options.enabled !== true) return noopMetricsSink;

  try {
    const meter = options.meterFactory?.() ?? (options.metricsApi ?? metrics).getMeter("agentj");
    const instruments: OtelInstruments = {
      duration: meter.createHistogram("agentj.llm.duration", instrumentOptions.duration),
      inputTokens: meter.createCounter("agentj.llm.tokens.input", instrumentOptions.tokens),
      longContextInputTokens: meter.createCounter(
        "agentj.llm.tokens.input_long_context",
        instrumentOptions.tokens,
      ),
      noCacheTokens: meter.createCounter("agentj.llm.tokens.no_cache", instrumentOptions.tokens),
      cacheReadTokens: meter.createCounter(
        "agentj.llm.tokens.cache_read",
        instrumentOptions.tokens,
      ),
      cacheWriteTokens: meter.createCounter(
        "agentj.llm.tokens.cache_write",
        instrumentOptions.tokens,
      ),
      outputTokens: meter.createCounter("agentj.llm.tokens.output", instrumentOptions.tokens),
      totalTokens: meter.createCounter("agentj.llm.tokens.total", instrumentOptions.tokens),
      cacheReadRatio: meter.createHistogram("agentj.llm.cache_read_ratio", instrumentOptions.ratio),
    };

    let failed = false;
    return {
      record(measurement) {
        if (failed) return;

        const attributes = sanitizeMetricAttributes(measurement.attributes);
        if (!isSafeMeasurement(measurement) || !attributes) return;

        try {
          recordMeasurement(instruments, { ...measurement, attributes });
        } catch {
          failed = true;
        }
      },
    };
  } catch {
    return noopMetricsSink;
  }
}

function isSafeMeasurement(measurement: MetricMeasurement): boolean {
  return Number.isFinite(measurement.value) && measurement.value >= 0;
}

function recordMeasurement(instruments: OtelInstruments, measurement: MetricMeasurement): void {
  switch (measurement.name) {
    case "model.duration_ms":
      instruments.duration.record(measurement.value, measurement.attributes);
      return;
    case "model.tokens.input":
      instruments.inputTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.tokens.input_long_context":
      instruments.longContextInputTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.tokens.no_cache":
      instruments.noCacheTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.tokens.cache_read":
      instruments.cacheReadTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.tokens.cache_write":
      instruments.cacheWriteTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.tokens.output":
      instruments.outputTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.tokens.total":
      instruments.totalTokens.add(measurement.value, measurement.attributes);
      return;
    case "model.cache_read_ratio":
      instruments.cacheReadRatio.record(measurement.value, measurement.attributes);
  }
}
