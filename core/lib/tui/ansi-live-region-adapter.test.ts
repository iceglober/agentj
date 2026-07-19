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

describe("createAnsiLiveRegionAdapter", () => {
  test("anchors logical layouts and their cursor to the terminal bottom", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });

    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 3 });

    expect(text()).toContain("[9;1Heditor\r\nstatus");
    expect(text()).toContain("[9;4H");
  });

  test("keeps transcript writes above the reserved live rows", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    region.printAbove("transcript");
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    // The write scrolls exactly enough to keep the 2-row live band free.
    expect(text()).toContain("transcript\r\n\r\n");
    expect(text().lastIndexOf("editor")).toBeGreaterThan(text().lastIndexOf("transcript"));
  });

  test("transcript writes reclaim rows vacated by a layout that shrank", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    const tall = ["p1", "p2", "p3", "p4", "editor", "status"];
    region.paint({ lines: tall, cursorRow: 4, cursorColumn: 0 });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    // Rows 5..10 are still reserved (anchor 6) though only 2 are painted. The
    // write clears the whole band (from row 5) and places its one line tight
    // above the 2-row live region — at row 8 — with no scroll padding, so the
    // vacated rows are reclaimed instead of left as a gap under the editor.
    region.printAbove("t1");
    const afterT1 = text();
    expect(afterT1).toContain("[5;1H[J");
    expect(afterT1).toContain("[8;1Ht1");
    expect(afterT1).not.toContain("t1\r\n");
  });

  test("scroll padding tracks the live-region height, not the text height", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    // A single line, full screen: two trailing newlines keep the 2-row band free.
    region.printAbove("t1");
    expect(text()).toContain("t1\r\n\r\n");
    expect(text()).not.toContain("t1\r\n\r\n\r\n");

    // A tall block must NOT pad proportionally to its height — the terminal
    // scrolls on its own as the text overflows, so the trailing padding stays
    // at the live-region height (2). This is the gap-that-grows-with-content bug.
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    const block = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\r\n");
    region.printAbove(block);
    expect(text()).toContain("L8\r\n\r\n");
    expect(text()).not.toContain("L8\r\n\r\n\r\n");
  });
});
