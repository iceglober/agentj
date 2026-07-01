import { context, diag, DiagConsoleLogger, DiagLogLevel, SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const VERSION = "0.1.0";
const tracerName = "agentj";
let sdkStarted = false;
let sdkStartPromise: Promise<void> | null = null;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function telemetryEnabled(): boolean {
  return truthy(process.env.OTEL_SDK_DISABLED) ? false : truthy(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.AGENTJ_OTEL_STDOUT ?? process.env.OTEL_LOG_LEVEL);
}

export async function initTelemetry(): Promise<void> {
  if (!telemetryEnabled()) return;
  if (sdkStarted) return;
  if (sdkStartPromise) return sdkStartPromise;
  sdkStartPromise = (async () => {
    if (process.env.OTEL_LOG_LEVEL) diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "agentj",
        [ATTR_SERVICE_VERSION]: VERSION,
      }),
      traceExporter: new OTLPTraceExporter(),
    });
    await sdk.start();
    sdkStarted = true;
    const shutdown = async (): Promise<void> => {
      try {
        await sdk.shutdown();
      } catch {
        // best effort on process exit
      }
    };
    process.once("beforeExit", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  })();
  return sdkStartPromise;
}

export function getTracer(): Tracer {
  return trace.getTracer(tracerName, VERSION);
}

export function recordError(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
}

export function addSpanEvent(span: Span, name: string, attributes?: Attributes): void {
  span.addEvent(name, attributes);
}

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(name, { attributes });
  try {
    return await context.with(trace.setSpan(context.active(), span), async () => await fn(span));
  } catch (err) {
    recordError(span, err);
    throw err;
  } finally {
    span.end();
  }
}

export function eventAttributes(kind: string, attrs: Record<string, unknown> = {}): Attributes {
  const out: Attributes = { "agentj.event.type": kind };
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = JSON.stringify(value);
  }
  return out;
}
