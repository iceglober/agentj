import { describe, expect, test } from "bun:test";
import { createTerminalStyler } from "./styles";
import { formatUserTurnBlock } from "./transcript";

describe("formatUserTurnBlock", () => {
  test("preserves every prompt line, including consecutive blank lines", () => {
    expect(formatUserTurnBlock("first\n\n\nsecond")).toEqual([
      [{ text: "❯", tone: "accent", bold: true }, { text: " " }, { text: "first", bold: true }],
      [{ text: "", bold: true }],
      [{ text: "", bold: true }],
      [{ text: "second", bold: true }],
    ]);
  });

  test("uses transcript overrides without a user-turn prefix", () => {
    expect(formatUserTurnBlock("internal prompt", "Command: build\nworking")).toEqual([
      [{ text: "Command: build" }],
      [{ text: "working" }],
    ]);
  });

  test("leaves terminal escaping to the shared screen renderer", () => {
    const block = formatUserTurnBlock("unsafe \u001b[2J\nnext");
    expect(createTerminalStyler({ color: false }).renderBlock(block)).toEqual([
      "❯ unsafe \\x1b[2J",
      "next",
    ]);
  });
});
