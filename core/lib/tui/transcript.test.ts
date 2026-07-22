import { describe, expect, test } from "bun:test";
import { createTerminalStyler } from "./styles";
import { displayWidth } from "./terminal-editor";
import { formatUserTurnBlock, wrapMutedBlock } from "./transcript";

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
      [{ text: "Command: build", tone: "muted" }],
      [{ text: "working", tone: "muted" }],
    ]);
  });

  test("wraps a long transcript override, keeping the leading indent on continuations", () => {
    const width = 24;
    const indented =
      "Reflection\n  a rather long indented reflection line that must wrap several times";
    const block = formatUserTurnBlock("internal", indented, width);
    // Every emitted line is muted and fits within the render width.
    for (const line of block) {
      expect(line.every((span) => span.tone === "muted")).toBe(true);
      const used = line.reduce((total, span) => total + displayWidth(span.text), 0);
      expect(used).toBeLessThanOrEqual(width);
    }
    // The indented source line wrapped into more than one line.
    const continuations = block.slice(1);
    expect(continuations.length).toBeGreaterThan(1);
    // Each continuation keeps the two-space hanging indent.
    for (const line of continuations) expect(line[0]?.text.startsWith("  ")).toBe(true);
  });
});

describe("wrapMutedBlock", () => {
  test("preserves each source line's indent on its wrapped continuations", () => {
    const block = wrapMutedBlock("  one two three four five six seven", 12);
    expect(block.length).toBeGreaterThan(1);
    for (const line of block) {
      expect(line[0]?.tone).toBe("muted");
      expect(line[0]?.text.startsWith("  ")).toBe(true);
      expect(displayWidth(line[0]?.text ?? "")).toBeLessThanOrEqual(12);
    }
  });

  test("hard-breaks a single word longer than the available width", () => {
    const block = wrapMutedBlock("abcdefghijklmnop", 6);
    expect(block.length).toBeGreaterThan(1);
    for (const line of block) expect(displayWidth(line[0]?.text ?? "")).toBeLessThanOrEqual(6);
    expect(block.map((line) => line[0]?.text).join("")).toBe("abcdefghijklmnop");
  });

  test("width undefined emits one muted line per source line, unwrapped", () => {
    expect(wrapMutedBlock("a very long line that would otherwise wrap\nsecond")).toEqual([
      [{ text: "a very long line that would otherwise wrap", tone: "muted" }],
      [{ text: "second", tone: "muted" }],
    ]);
  });

  test("leaves terminal escaping to the shared screen renderer", () => {
    const block = formatUserTurnBlock("unsafe \u001b[2J\nnext");
    expect(createTerminalStyler({ color: false }).renderBlock(block)).toEqual([
      " ",
      " ❯ unsafe \\x1b[2J ",
      " next ",
      " ",
    ]);
  });
});
