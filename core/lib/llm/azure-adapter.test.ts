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
  }) as typeof fetch;
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
