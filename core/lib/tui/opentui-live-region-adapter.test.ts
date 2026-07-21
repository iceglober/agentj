import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createOpenTuiLiveRegionAdapter } from "./opentui-live-region-adapter";

const createStreams = () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 40;
  stdout.rows = 10;
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stdin, stdout, output: () => Buffer.concat(chunks).toString("utf8") };
};

describe("createOpenTuiLiveRegionAdapter", () => {
  test("renders semantic scrollback and owns the split footer lifecycle", async () => {
    const streams = createStreams();
    const region = await createOpenTuiLiveRegionAdapter({
      stdin: streams.stdin as unknown as NodeJS.ReadStream,
      stdout: streams.stdout,
    });
    expect(region.width()).toBe(39);
    expect(region.height()).toBe(10);
    region.printAbove([[{ text: " user ", background: "muted", bold: true }]]);
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    expect(streams.output()).toContain("opentui");
    region.dispose?.();
    region.dispose?.();
  });
});
