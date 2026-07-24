import { describe, expect, test } from "bun:test";
import { fetchModelCatalog } from "./catalog";

const catalog = {
  openai: {
    models: {
      "gpt-4o": { modalities: { output: ["text"] } },
      "gpt-image-1": { modalities: { output: ["image"] } },
      o3: {}, // no modalities → treated as text
    },
  },
  "google-vertex": { models: { "gemini-2.0-flash": { modalities: { output: ["text"] } } } },
  cohere: { models: {} },
};

const fakeFetch = (ok = true): typeof fetch =>
  (async () =>
    ({
      ok,
      status: ok ? 200 : 503,
      json: async () => catalog,
    }) as unknown as Response) as unknown as typeof fetch;

describe("fetchModelCatalog", () => {
  test("maps our provider names to models.dev ids and keeps only text models", async () => {
    const models = await fetchModelCatalog(fakeFetch());
    // image-only model dropped; text and unspecified kept; sorted.
    expect(models.openai).toEqual(["gpt-4o", "o3"]);
    // our `vertex` reads models.dev `google-vertex`.
    expect(models.vertex).toEqual(["gemini-2.0-flash"]);
    // a provider present but empty → [].
    expect(models.cohere).toEqual([]);
    // a provider missing from the catalog → [].
    expect(models.anthropic).toEqual([]);
    // openai-compatible has no fixed catalog.
    expect(models["openai-compatible"]).toEqual([]);
  });

  test("throws on a non-ok response so the caller can fall back", async () => {
    await expect(fetchModelCatalog(fakeFetch(false))).rejects.toThrow(/models\.dev/);
  });
});
