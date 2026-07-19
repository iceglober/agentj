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

    expect(text()).toContain("\u001b[9;1Heditor\r\nstatus");
    expect(text()).toContain("\u001b[9;4H");
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

    // Rows 5..10 are reserved (anchor 6) but only 2 are painted. The next
    // transcript line must land at the top of that band — row 5 — and consume
    // it rather than re-padding six newlines under itself.
    region.printAbove("t1");
    const afterT1 = text();
    expect(afterT1).toContain("[5;1Ht1\r\n");
    expect(afterT1).not.toContain("t1\r\n\r\n\r\n");

    // The band shrank by two rows (text + separator): the next write lands
    // two rows lower, still without any scroll padding.
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    region.printAbove("t2");
    expect(text()).toContain("[7;1Ht2\r\n");
    expect(text()).not.toContain("t2\r\n\r\n\r\n");
  });

  test("steady-state writes scroll once the vacated band is used up", () => {
    const { output, text } = createOutput();
    const region = createAnsiLiveRegionAdapter({ stdout: output });
    region.paint({ lines: ["p1", "editor", "status"], cursorRow: 1, cursorColumn: 0 });
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });

    region.printAbove("t1"); // consumes the single vacated row; anchor floors at 2
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    region.printAbove("t2"); // no band left: must scroll to keep 2 rows free
    expect(text()).toContain("t2\r\n\r\n");
  });
});
