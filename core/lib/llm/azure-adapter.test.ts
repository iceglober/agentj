import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRequestDeadline, LLM_REQUEST_TIMEOUT_MS } from "./azure-adapter";

/**
 * The deadline wrapper exists because Bun's fetch otherwise imposes a
 * hardcoded 5-minute timeout that killed long reasoning requests. These tests
 * pin its contract: every request carries an explicit signal, and a caller's
 * own abort still wins.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const captureFetch = (): { init: RequestInit | undefined }[] => {
  const calls: { init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ init });
    return new Response("ok");
  }) as unknown as typeof fetch;
  return calls;
};

describe("fetchWithRequestDeadline", () => {
  test("attaches a deadline signal when the caller passes none", async () => {
    const calls = captureFetch();
    await fetchWithRequestDeadline("https://example.test");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });

  test("composes the deadline with a caller signal — the caller's abort wins", async () => {
    const calls = captureFetch();
    const caller = new AbortController();
    await fetchWithRequestDeadline("https://example.test", { signal: caller.signal });
    const sent = calls[0]?.init?.signal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent?.aborted).toBe(false);
    caller.abort();
    expect(sent?.aborted).toBe(true);
  });

  test("the deadline leaves headroom far beyond Bun's 5-minute default", () => {
    expect(LLM_REQUEST_TIMEOUT_MS).toBeGreaterThan(5 * 60_000);
  });
});

describe("fetchWithRequestDeadline retry", () => {
  test("does not retry HTTP error responses", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRequestDeadline("https://example.test");

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("retries a timed-out request and returns the recovered response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3)
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      return new Response("recovered");
    }) as unknown as typeof fetch;
    const response = await fetchWithRequestDeadline("https://example.test");
    expect(await response.text()).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("gives up after the attempt budget", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await expect(fetchWithRequestDeadline("https://example.test")).rejects.toThrow("timed out");
    expect(calls).toBe(3);
  });

  test("a caller abort is honored immediately, never retried", async () => {
    let calls = 0;
    const caller = new AbortController();
    globalThis.fetch = (async () => {
      calls += 1;
      caller.abort();
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }) as unknown as typeof fetch;
    await expect(
      fetchWithRequestDeadline("https://example.test", { signal: caller.signal }),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  test("non-transient errors propagate without a retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw Object.assign(new Error("bad request assembly"), { name: "SyntaxError" });
    }) as unknown as typeof fetch;
    await expect(fetchWithRequestDeadline("https://example.test")).rejects.toThrow(
      "bad request assembly",
    );
    expect(calls).toBe(1);
  });
});
