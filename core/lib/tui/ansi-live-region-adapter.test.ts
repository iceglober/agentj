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

    expect(text()).toContain("transcript\r\n\r\n\r\n");
    expect(text().lastIndexOf("editor")).toBeGreaterThan(text().lastIndexOf("transcript"));
  });
});
