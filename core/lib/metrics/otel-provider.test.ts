import { describe, expect, test } from "bun:test";
import type { MeterProvider, PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { metricsConfigSchema } from "./index";
import { startMetricsProvider } from "./otel-provider";

const fakeExporter = (): PushMetricExporter => ({
  export: (_metrics, resultCallback) => resultCallback({ code: 0 }),
  forceFlush: async () => {},
  shutdown: async () => {},
});

describe("metricsConfigSchema", () => {
  test("{} is valid and disabled with sane otlp defaults", () => {
    const config = metricsConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.otlp.endpoint).toBeUndefined();
    expect(config.otlp.intervalMs).toBe(60_000);
    expect(config.otlp.headers).toEqual({});
  });

  test("rejects non-URL endpoints and sub-second intervals", () => {
    expect(() => metricsConfigSchema.parse({ otlp: { endpoint: "not a url" } })).toThrow();
    expect(() => metricsConfigSchema.parse({ otlp: { intervalMs: 10 } })).toThrow();
  });
});

describe("startMetricsProvider", () => {
  test("no endpoint → no provider (sink falls back to the global meter)", () => {
    expect(startMetricsProvider(metricsConfigSchema.parse({ enabled: true }))).toBeUndefined();
  });

  test("endpoint stands up a registered provider; headersFromEnv resolves from env", () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let registered: MeterProvider | undefined;
    const handle = startMetricsProvider(
      metricsConfigSchema.parse({
        enabled: true,
        otlp: {
          endpoint: "http://collector.local:4318/v1/metrics",
          headers: { "X-Static": "yes" },
          headersFromEnv: { Authorization: "OTEL_AUTH", Missing: "UNSET_VAR" },
        },
      }),
      {
        env: { OTEL_AUTH: "Bearer token" },
        createExporter: (options) => {
          seen.push(options);
          return fakeExporter();
        },
        register: (provider) => {
          registered = provider;
        },
      },
    );
    expect(handle).toBeDefined();
    expect(registered).toBeDefined();
    expect(seen).toEqual([
      {
        url: "http://collector.local:4318/v1/metrics",
        headers: { "X-Static": "yes", Authorization: "Bearer token" },
      },
    ]);
  });

  test("shutdown flushes and never throws", async () => {
    const handle = startMetricsProvider(
      metricsConfigSchema.parse({
        enabled: true,
        otlp: { endpoint: "http://collector.local:4318/v1/metrics" },
      }),
      { createExporter: fakeExporter, register: () => {} },
    );
    await expect(handle?.shutdown()).resolves.toBeUndefined();
  });

  test("a throwing exporter factory degrades to undefined, never an error", () => {
    const handle = startMetricsProvider(
      metricsConfigSchema.parse({
        enabled: true,
        otlp: { endpoint: "http://collector.local:4318/v1/metrics" },
      }),
      {
        createExporter: () => {
          throw new Error("boom");
        },
        register: () => {},
      },
    );
    expect(handle).toBeUndefined();
  });
});
