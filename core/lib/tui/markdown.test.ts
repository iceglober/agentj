import { describe, expect, test } from "bun:test";
import { renderMarkdownLite } from "./markdown";

describe("renderMarkdownLite", () => {
  test("returns semantic bold, italic, inline-code, and header spans", () => {
    expect(renderMarkdownLite("a **bold** and __also__ word")).toEqual([
      [
        { text: "a " },
        { text: "bold", bold: true },
        { text: " and " },
        { text: "also", bold: true },
        { text: " word" },
      ],
    ]);
    expect(renderMarkdownLite("an *italic* word")[0]).toContainEqual({
      text: "italic",
      italic: true,
    });
    expect(renderMarkdownLite("run `bun test` now")[0]).toContainEqual({
      text: "bun test",
      tone: "accent",
    });
    expect(renderMarkdownLite("## Title")).toEqual([
      [{ text: "Title", bold: true, underline: true }],
    ]);
  });

  test("code fences stay verbatim and only fence markers are muted", () => {
    const output = renderMarkdownLite("```ts\nconst a = 1; // **not bold**\n```");
    expect(output[0]).toEqual([{ text: "```ts", tone: "muted" }]);
    expect(output[1]).toEqual([{ text: "const a = 1; // **not bold**" }]);
    expect(output[2]).toEqual([{ text: "```", tone: "muted" }]);
  });

  test("plain text, multiplication, and snake_case survive untouched", () => {
    expect(renderMarkdownLite("2 * 3 * 4 and snake_case_name")).toEqual([
      [{ text: "2 * 3 * 4 and snake_case_name" }],
    ]);
  });
});
