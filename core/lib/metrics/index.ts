/**
 * Vendor-neutral, aggregate model metrics. Values deliberately exclude request
 * content and deployment pricing: callers can observe token/cache behavior,
 * but cannot derive or report a USD cost without their own pricing policy.
 */

export const metricAttributeKeys = ["provider", "model", "outcome"] as const;

export type MetricAttributeKey = (typeof metricAttributeKeys)[number];
export type MetricAttributes = Readonly<Record<MetricAttributeKey, string>>;
export type MetricAttributesInput = Partial<Record<MetricAttributeKey, unknown>> &
  Record<string, unknown>;

export interface ModelUsageMetrics {
  durationMs: number;
  inputTokens?: number;
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ModelUsageMetricName =
  | "model.duration_ms"
  | "model.tokens.input"
  | "model.tokens.no_cache"
  | "model.tokens.cache_read"
  | "model.tokens.cache_write"
  | "model.tokens.output"
  | "model.tokens.total"
  | "model.cache_read_ratio";

export interface MetricMeasurement {
  name: ModelUsageMetricName;
  value: number;
  attributes: MetricAttributes;
}

export interface MetricsSink {
  record(measurement: MetricMeasurement): void;
}

export const noopMetricsSink: MetricsSink = { record: () => undefined };

const attributeValuePatterns: Record<MetricAttributeKey, RegExp> = {
  provider: /^[a-z][a-z0-9-]{0,62}$/i,
  model: /^[a-z0-9][a-z0-9._:-]{0,127}$/i,
  outcome: /^[a-z][a-z0-9_-]{0,62}$/i,
};

/**
 * Returns only the fixed, low-cardinality attribute set. Free-form strings,
 * paths, whitespace, and unknown keys are rejected rather than exported.
 */
export function sanitizeMetricAttributes(
  input: Record<string, unknown>,
): MetricAttributes | undefined {
  const keys = Object.keys(input);
  if (keys.some((key) => !metricAttributeKeys.includes(key as MetricAttributeKey))) {
    return undefined;
  }

  const attributes = {} as Record<MetricAttributeKey, string>;
  for (const key of metricAttributeKeys) {
    const value = input[key];
    if (typeof value !== "string" || !attributeValuePatterns[key].test(value)) {
      return undefined;
    }
    attributes[key] = value;
  }

  return attributes;
}

export function createMetricAttributes(input: MetricAttributesInput): MetricAttributes | undefined {
  return sanitizeMetricAttributes(input);
}

const tokenMeasurements: ReadonlyArray<
  readonly [keyof Omit<ModelUsageMetrics, "durationMs">, ModelUsageMetricName]
> = [
  ["inputTokens", "model.tokens.input"],
  ["noCacheTokens", "model.tokens.no_cache"],
  ["cacheReadTokens", "model.tokens.cache_read"],
  ["cacheWriteTokens", "model.tokens.cache_write"],
  ["outputTokens", "model.tokens.output"],
  ["totalTokens", "model.tokens.total"],
];

function isMetricValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function record(sink: MetricsSink, measurement: MetricMeasurement): void {
  try {
    sink.record(measurement);
  } catch {
    // Metrics must never change task success or failure.
  }
}

/** Records aggregate token/cache/duration measurements; no monetary cost is calculated. */
export function recordModelUsage(
  sink: MetricsSink | undefined,
  attributes: MetricAttributesInput,
  usage: ModelUsageMetrics,
): void {
  try {
    if (!sink) return;

    const safeAttributes = createMetricAttributes(attributes);
    if (!safeAttributes) return;

    if (isMetricValue(usage.durationMs)) {
      record(sink, { name: "model.duration_ms", value: usage.durationMs, attributes: safeAttributes });
    }

    for (const [key, name] of tokenMeasurements) {
      const value = usage[key];
      if (isMetricValue(value)) record(sink, { name, value, attributes: safeAttributes });
    }

    if (isMetricValue(usage.inputTokens) && isMetricValue(usage.cacheReadTokens) && usage.inputTokens > 0) {
      record(sink, {
        name: "model.cache_read_ratio",
        value: usage.cacheReadTokens / usage.inputTokens,
        attributes: safeAttributes,
      });
    }
  } catch {
    // Attribute or usage extraction is telemetry work too; it cannot fail a task.
  }
}
