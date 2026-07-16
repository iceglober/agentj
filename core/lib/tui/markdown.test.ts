import { describe, expect, test } from "bun:test";
import { renderMarkdownLite } from "./markdown";

const BOLD = "\u001b[1m";
const ITALIC = "\u001b[3m";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

describe("renderMarkdownLite", () => {
  test("bold, italic, inline code, and headers", () => {
    expect(renderMarkdownLite("a **bold** and __also__ word")).toBe(
      `a ${BOLD}bold${RESET} and ${BOLD}also${RESET} word`,
    );
    expect(renderMarkdownLite("an *italic* word")).toBe(`an ${ITALIC}italic${RESET} word`);
    expect(renderMarkdownLite("run `bun test` now")).toBe(`run ${CYAN}bun test${RESET} now`);
    expect(renderMarkdownLite("## Title")).toBe(`${BOLD}\u001b[4mTitle${RESET}`);
  });

  test("code fences pass through verbatim with dimmed fence markers", () => {
    const input = "```ts\nconst a = 1; // **not bold**\n```";
    const output = renderMarkdownLite(input);
    expect(output).toContain(`${DIM}\`\`\`ts${RESET}`);
    expect(output).toContain("const a = 1; // **not bold**");
    expect(output).not.toContain(`${BOLD}not bold${RESET}`);
  });

  test("plain text, multiplication, and snake_case survive untouched", () => {
    expect(renderMarkdownLite("2 * 3 * 4 and snake_case_name")).toBe(
      "2 * 3 * 4 and snake_case_name",
    );
  });
});
