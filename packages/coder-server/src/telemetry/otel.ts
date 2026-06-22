// OpenTelemetry — spans + metrics for every operation, from day one (PLAN R12).
// Each turn, model call, tool/Capability, Extractor, context assembly, Distiller run
// emits a span; model spans capture per-provider usage + cost via the AI SDK's
// `experimental_telemetry`. OTLP export to any backend; **no-op when unconfigured** (N8).
//
// This module wraps `@opentelemetry/api` behind a thin seam so the rest of the server
// never imports it directly and telemetry stays a no-op until an exporter is wired (P1).

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: unknown): void;
  end(): void;
}

export interface Telemetry {
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span;
  /** `gen.output.verbosity` and friends. */
  recordMetric(name: string, value: number, attrs?: Record<string, string>): void;
}

/** Default no-op telemetry — active until an OTLP exporter is configured (N8). */
export const noopTelemetry: Telemetry = {
  startSpan: () => ({
    setAttribute: () => {},
    recordException: () => {},
    end: () => {},
  }),
  recordMetric: () => {},
};

// TODO(P1): wire @opentelemetry/api + OTLP exporter; emit gen.output.verbosity and
// per-provider token/cost/latency from AI SDK experimental_telemetry.
export function createTelemetry(): Telemetry {
  return noopTelemetry;
}
