import { describe, expect, test } from "bun:test";
import type { McpServerClient } from "../../mcp";
import { createWebTools } from ".";
import { createExaWebSearch } from "./exa-adapter";
import { createHttpWebFetch, isPublicAddress } from "./http-adapter";

describe("createWebTools", () => {
  test("passes bounded searches and marks external output untrusted", async () => {
    const calls: Array<{ query: string; limit: number; signal?: AbortSignal }> = [];
    const tools = createWebTools({
      search: {
        async search(input) {
          calls.push(input);
          return { results: [input.query] };
        },
      },
      fetch: {
        async fetch(url) {
          return { url, contentType: "text/plain", text: "page text" };
        },
      },
      maxOutputChars: 1_000,
    });
    const signal = new AbortController().signal;
    const search = String(
      await tools.web_search.execute({ query: "agentj", limit: 3 }, { abortSignal: signal }),
    );
    const page = String(await tools.web_fetch.execute({ url: "https://example.com/guide" }));

    expect(calls).toEqual([{ query: "agentj", limit: 3, signal }]);
    expect(search).toContain("Untrusted web content");
    expect(search).toContain("agentj");
    expect(page).toContain("URL: https://example.com/guide");
    expect(page).toContain("page text");
  });

  test("returns tool errors instead of throwing", async () => {
    const tools = createWebTools({
      search: { search: async () => Promise.reject(new Error("unavailable")) },
      fetch: { fetch: async () => Promise.reject(new Error("blocked")) },
      maxOutputChars: 1_000,
    });
    await expect(tools.web_search.execute({ query: "x", limit: 1 })).resolves.toContain(
      "web search failed",
    );
    await expect(tools.web_fetch.execute({ url: "https://example.com" })).resolves.toContain(
      "web fetch failed",
    );
  });
});

describe("createExaWebSearch", () => {
  test("connects lazily, uses Exa's search tool, and closes the client", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
    let closes = 0;
    let connects = 0;
    const client = {
      async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
        calls.push({ name, args, ...(signal ? { signal } : {}) });
        return { content: [{ type: "text", text: "result" }] };
      },
      async close() {
        closes += 1;
      },
    } as unknown as McpServerClient;
    const search = createExaWebSearch({
      connect: async () => {
        connects += 1;
        return client;
      },
    });
    expect(connects).toBe(0);
    const signal = new AbortController().signal;
    expect(String(await search.search({ query: "Bun", limit: 2, signal }))).toContain("result");
    expect(calls).toEqual([
      {
        name: "web_search_exa",
        args: { query: "Bun", numResults: 2, contextMaxCharacters: 20_000 },
        signal,
      },
    ]);
    await search.close();
    expect(closes).toBe(1);
  });
});

describe("isPublicAddress", () => {
  test("permits public addresses and rejects private or special ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.1.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.1.1",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "::ffff:8.8.8.8",
      "fe80::1",
      "fc00::1",
      "64:ff9b::808:808",
      "100::1",
      "2001:2::1",
      "2001:db8::1",
      "2002::1",
      "ff02::1",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("rejects URL schemes, credentials, and hosts that resolve only to blocked addresses", async () => {
    const fetch = createHttpWebFetch({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(fetch.fetch("file:///etc/passwd")).rejects.toThrow("only HTTP and HTTPS");
    await expect(fetch.fetch("https://user:pass@example.com")).rejects.toThrow("credentials");
    await expect(fetch.fetch("https://example.com")).rejects.toThrow("blocked addresses");
  });
});
