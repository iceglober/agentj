import { describe, expect, test } from "bun:test";
import { createTerminalStyler } from "./styles";
import { displayWidth } from "./terminal-editor";
import { formatUserTurnBlock } from "./transcript";

describe("formatUserTurnBlock", () => {
  test("pads every line to the width so the muted block is a solid rectangle", () => {
    const width = 20;
    const block = formatUserTurnBlock("hi\nthere", undefined, width);
    // A blank padding row on top and bottom around the two content lines.
    expect(block.length).toBe(4);
    for (const line of block) {
      const used = line.reduce((total, span) => total + displayWidth(span.text), 0);
      expect(used).toBe(width);
      expect(line.every((span) => span.background === "muted")).toBe(true);
    }
  });

  test("preserves every prompt line, including consecutive blank lines", () => {
    expect(formatUserTurnBlock("first\n\n\nsecond")).toEqual([
      [{ text: " ", background: "muted" }],
      [
        { text: " ", background: "muted" },
        { text: "❯", tone: "accent", bold: true, background: "muted" },
        { text: " ", background: "muted" },
        { text: "first", bold: true, background: "muted" },
        { text: " ", background: "muted" },
      ],
      [{ text: "  ", bold: true, background: "muted" }],
      [{ text: "  ", bold: true, background: "muted" }],
      [{ text: " second ", bold: true, background: "muted" }],
      [{ text: " ", background: "muted" }],
    ]);
  });

  test("uses transcript overrides without a user-turn prefix", () => {
    expect(formatUserTurnBlock("internal prompt", "Command: build\nworking")).toEqual([
      [{ text: "Command: build" }],
      [{ text: "working" }],
    ]);
  });

  test("leaves terminal escaping to the shared screen renderer", () => {
    const block = formatUserTurnBlock("unsafe [2J\nnext");
    expect(createTerminalStyler({ color: false }).renderBlock(block)).toEqual([
      " ",
      " ❯ unsafe \\x1b[2J ",
      " next ",
      " ",
    ]);
  });
});
