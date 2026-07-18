import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { MetricsConfig } from "./index";

export interface MetricsProviderHandle {
  /** Force-flush pending exports and tear the provider down. */
  shutdown(): Promise<void>;
}

export interface StartMetricsProviderOptions {
  env?: Record<string, string | undefined>;
  /** Test injection: swap the OTLP exporter without touching the network. */
  createExporter?: (options: {
    url: string;
    headers: Record<string, string>;
  }) => PushMetricExporter;
  /** Test injection: observe/replace global meter-provider registration. */
  register?: (provider: MeterProvider) => void;
}

/**
 * Stand up the self-contained OTLP metrics pipeline: exporter → periodic
 * reader → MeterProvider registered as the OTel global, which is where
 * `createOtelMetricsSink` resolves its meter from. Returns undefined when the
 * config carries no endpoint (the sink then uses whatever global provider an
 * external bootstrap registered) or when construction fails — telemetry must
 * never break the run.
 */
export function startMetricsProvider(
  config: MetricsConfig,
  options: StartMetricsProviderOptions = {},
): MetricsProviderHandle | undefined {
  const { endpoint, headers, headersFromEnv, intervalMs } = config.otlp;
  if (!endpoint) return undefined;
  try {
    const env = options.env ?? process.env;
    const resolvedHeaders = { ...headers };
    for (const [header, envVar] of Object.entries(headersFromEnv)) {
      const value = env[envVar];
      if (value) resolvedHeaders[header] = value;
    }
    const exporter =
      options.createExporter?.({ url: endpoint, headers: resolvedHeaders }) ??
      new OTLPMetricExporter({ url: endpoint, headers: resolvedHeaders });
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: intervalMs })],
    });
    (options.register ?? ((p: MeterProvider) => metrics.setGlobalMeterProvider(p)))(provider);
    return {
      shutdown: async () => {
        try {
          await provider.forceFlush();
          await provider.shutdown();
        } catch {}
      },
    };
  } catch {
    return undefined;
  }
}
