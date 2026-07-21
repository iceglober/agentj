import { describe, expect, test } from "bun:test";
import { createTerminalStyler } from "./styles";
import { displayWidth } from "./terminal-editor";

describe("createTerminalStyler", () => {
  test("escapes content before adding trusted ANSI and respects color capability", () => {
    const color = createTerminalStyler({ color: true });
    expect(color.renderLine([{ text: "<Y>", tone: "accent", bold: true }])).toBe(
      "\u001b[1m\u001b[36m<Y>\u001b[0m",
    );
    expect(color.renderLine([{ text: "\u001b[2J" }])).toBe("\\x1b[2J");
    const plain = createTerminalStyler({ color: false });
    expect(plain.renderLine([{ text: "<Y>", tone: "accent", bold: true }])).toBe("<Y>");
    expect(color.renderLine([{ text: " user ", background: "muted", bold: true }])).toBe(
      "\u001b[1m\u001b[100m user \u001b[0m",
    );
    expect(plain.renderLine([{ text: " user ", background: "muted", bold: true }])).toBe(" user ");
  });

  test("truncates semantic spans by display width before styling", () => {
    const line = createTerminalStyler({ color: true }).renderLine(
      [{ text: "wide " }, { text: "🌍 hello", tone: "accent" }],
      8,
    );
    expect(displayWidth(line)).toBeLessThanOrEqual(8);
    expect(line).toEndWith("…");
  });
});
