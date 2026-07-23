import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createAnsiLiveRegionAdapter } from "./ansi-live-region-adapter";

const ESC = "";
const createRegion = () => {
  const output = new PassThrough() as PassThrough & { columns: number; rows: number };
  output.columns = 40;
  output.rows = 10;
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const region = createAnsiLiveRegionAdapter({ stdout: output });
  const all = () => Buffer.concat(chunks).toString("utf8");
  // Bytes written by `fn` alone.
  const tap = (fn: () => void): string => {
    const before = all().length;
    fn();
    return all().slice(before);
  };
  return { region, tap };
};

const newlineCount = (s: string): number => (s.match(/\r\n/g) ?? []).length;
// Drop the synchronized-update markers so content assertions ignore the wrapper.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the sync markers
const stripSync = (s: string): string => s.replace(/\[\?2026[hl]/gu, "");

describe("createAnsiLiveRegionAdapter (floating)", () => {
  test("paint draws the layout beneath the transcript with relative moves, not absolute rows", () => {
    const { region, tap } = createRegion();
    const written = tap(() =>
      region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 }),
    );
    // A repaint is one atomic synchronized update, so the cursor never flickers.
    expect(written.startsWith(`${ESC}[?2026h`)).toBe(true);
    expect(written.endsWith(`${ESC}[?2026l`)).toBe(true);
    expect(written).toContain("editor\r\nstatus");
    // Floating never addresses an absolute row (…;1H) — that was the pinned design.
    expect(written).not.toMatch(/\[\d+;1H/u);
    // Cursor parks back up onto the editor row.
    expect(written).toContain(`${ESC}[1A`);
  });

  test("a transcript write adds no implicit spacing", () => {
    const { region, tap } = createRegion();
    // A tall live region (progress block + editor + status), like mid-turn.
    region.paint({ lines: ["p1", "p2", "p3", "editor", "status"], cursorRow: 3, cursorColumn: 0 });

    const written = tap(() => region.printAbove("row1"));
    // Walks up to the region top, clears, and writes only the event line.
    expect(written).toContain(`${ESC}[3A`);
    expect(stripSync(written).endsWith("row1\r\n")).toBe(true);
    expect(newlineCount(written)).toBe(1);
  });

  test("turn spacing is explicit and event writes remain adjacent", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["p1", "p2", "editor", "status"], cursorRow: 2, cursorColumn: 0 });

    region.printAbove("a");
    region.paint({ lines: ["", "editor", "status"], cursorRow: 1, cursorColumn: 0 });
    const second = tap(() => region.printAbove("b"));

    expect(stripSync(second).endsWith("b\r\n")).toBe(true);
    expect(newlineCount(second)).toBe(1);
    const turn = tap(() => region.printAbove("next", "turn"));
    expect(stripSync(turn).endsWith("\r\nnext\r\n")).toBe(true);
  });

  test("a tall transcript block scrolls naturally with only the one separator", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    const block = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\r\n");

    const written = tap(() => region.printAbove(block));
    // The block's own 7 newlines plus its terminating newline.
    expect(stripSync(written).endsWith("L8\r\n")).toBe(true);
    expect(newlineCount(written)).toBe(8);
  });

  test("clearScreen clears the full viewport and homes the cursor", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    expect(tap(() => region.clearScreen())).toBe(`${ESC}[2J${ESC}[H`);
  });

  test("clear erases the drawn region and forgets it", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["a", "b", "editor"], cursorRow: 2, cursorColumn: 0 });
    const written = tap(() => region.clear());
    expect(written).toContain(`${ESC}[2A`); // up to the region top
    expect(written).toContain(`${ESC}[J`); // clear to end of screen
  });
});
