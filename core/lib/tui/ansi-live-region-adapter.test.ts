import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createAnsiLiveRegionAdapter } from "./ansi-live-region-adapter";

const createOutput = (): {
  output: PassThrough & { columns: number; rows: number };
  text: () => string;
} => {
  const output = new PassThrough() as PassThrough & { columns: number; rows: number };
  output.columns = 40;
  output.rows = 10;
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { output, text: () => Buffer.concat(chunks).toString("utf8") };
};

/** Bytes written by `fn`, isolated from everything emitted before it. */
const tapLast =
  (text: () => string) =>
  (fn: () => void): string => {
    const before = text().length;
    fn();
    return text().slice(before);
  };

describe("createAnsiLiveRegionAdapter", () => {
  test("anchors logical layouts and their cursor to the terminal bottom", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });

    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 3 });

    expect(text()).toContain("[9;1Heditor\r\nstatus");
    expect(text()).toContain("[9;4H");
  });

  test("printAbove lands text on the bottom row and emits no trailing scroll padding", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    const before = text().length;
    region.printAbove("t1");
    const written = text().slice(before);
    // Last line of the text sits on row 10 (bottom); the following paint scrolls
    // it up by the live-region height, so printAbove itself pads nothing.
    expect(written).toContain("[10;1Ht1");
    expect(written.endsWith("t1")).toBe(true);
    expect(written).not.toContain("t1\r\n");
  });

  test("padding never scales with text height", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    const tap = tapLast(text);
    const block = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\r\n");
    const written = tap(() => region.printAbove(block));
    // The 8-line block overflows and the terminal scrolls on its own; printAbove
    // adds no trailing newlines, so nothing follows the block's last line.
    expect(written.endsWith("L8")).toBe(true);
    expect(written).not.toContain("L8\r\n");
  });

  test("padding never scales with a stale (taller) live region — the shrink-gap bug", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    // A tall completion menu, then a shrink back to the 2-row editor. The band
    // (anchor) stays 6 until reclaimed, but the visible region is 2.
    region.paint({
      lines: ["m1", "m2", "m3", "m4", "editor", "status"],
      cursorRow: 4,
      cursorColumn: 0,
    });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    const tap = tapLast(text);
    const written = tap(() => region.printAbove("Command: help"));
    // Clears the whole vacated band (from row 5) and still lands the line on the
    // bottom row (10) with no padding — no gap the size of the dismissed menu.
    expect(written).toContain("[5;1H[J");
    expect(written).toContain("[10;1HCommand: help");
    expect(written).not.toContain("help\r\n");
  });
});
