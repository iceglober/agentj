// Tiny JSON-over-HTTP client with a hard timeout. Callers that retry on timeout must think about
// idempotency — see ops/incident.md for what happens when they don't.
export interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: generic JSON transport
  body: any;
  headers: Headers;
}

export async function fetchJson(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 1000);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctl.signal,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}
