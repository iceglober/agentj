import { describe, expect, test } from "bun:test";
import { createEditorState } from "./editor";
import { findEditorToken, findEditorTokens } from "./editor-completion";

describe("editor completion tokens", () => {
  test("finds slash and @ tokens at start or after whitespace", () => {
    expect(findEditorTokens("/build note @src/main.ts\n/help")).toEqual([
      { start: 0, end: 6, sigil: "/", query: "build" },
      { start: 12, end: 24, sigil: "@", query: "src/main.ts" },
      { start: 25, end: 30, sigil: "/", query: "help" },
    ]);
  });

  test("does not recognize tokens preceded by non-whitespace and preserves quoted paths", () => {
    expect(findEditorTokens('word/foo x@no @"my file.ts"')).toEqual([
      { start: 14, end: 27, sigil: "@", query: '"my file.ts"' },
    ]);
  });

  test("finds only the token under the grapheme-aware cursor", () => {
    expect(
      findEditorToken({ ...createEditorState("say /bld then @src/a.ts"), cursor: 8 }),
    ).toMatchObject({
      sigil: "/",
      query: "bld",
    });
    expect(
      findEditorToken({ ...createEditorState("say /bld then @src/a.ts"), cursor: 13 }),
    ).toBeNull();
  });
});
