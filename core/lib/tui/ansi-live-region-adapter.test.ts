import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createAnsiLiveRegionAdapter } from "./ansi-live-region-adapter";

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

describe("createAnsiLiveRegionAdapter (floating)", () => {
  test("paint draws the layout beneath the transcript with relative moves, not absolute rows", () => {
    const { region, tap } = createRegion();
    const written = tap(() =>
      region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 }),
    );
    expect(written).toContain("editor\r\nstatus");
    // Floating never addresses an absolute row (…;1H) — that was the pinned design.
    expect(written).not.toMatch(/\[\d+;1H/);
    // Cursor parks back up onto the editor row.
    expect(written).toContain("[1A");
  });

  test("a transcript write adds one constant separator, never the region height", () => {
    const { region, tap } = createRegion();
    // A tall live region (progress block + editor + status), like mid-turn.
    region.paint({ lines: ["p1", "p2", "p3", "editor", "status"], cursorRow: 3, cursorColumn: 0 });

    const written = tap(() => region.printAbove("row1"));
    // Walks up to the region top, clears, writes the line + one blank separator.
    expect(written).toContain("[3A"); // erase: up to region top (cursor was 3 rows down)
    expect(written.endsWith("row1\r\n\r\n")).toBe(true);
    expect(newlineCount(written)).toBe(2); // one line + one separator — NOT the 5-row height
  });

  test("consecutive writes keep the same one-row separator regardless of region height", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["p1", "p2", "editor", "status"], cursorRow: 2, cursorColumn: 0 });

    region.printAbove("a");
    region.paint({ lines: ["", "editor", "status"], cursorRow: 1, cursorColumn: 0 });
    const second = tap(() => region.printAbove("b"));

    // Same constant separator whether the region was 4 rows or 3 — no height
    // ever leaks in as extra padding.
    expect(second.endsWith("b\r\n\r\n")).toBe(true);
    expect(newlineCount(second)).toBe(2);
  });

  test("a tall transcript block scrolls naturally with only the one separator", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    const block = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\r\n");

    const written = tap(() => region.printAbove(block));
    // The block's own 7 newlines plus one separator; the terminal scrolls it
    // into history on its own — the adapter adds no height-based padding.
    expect(written.endsWith("L8\r\n\r\n")).toBe(true);
    expect(newlineCount(written)).toBe(9);
  });

  test("clearScreen clears the full viewport and homes the cursor", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["editor", "status"], cursorRow: 0, cursorColumn: 0 });
    expect(tap(() => region.clearScreen())).toBe("\u001b[2J\u001b[H");
  });

  test("clear erases the drawn region and forgets it", () => {
    const { region, tap } = createRegion();
    region.paint({ lines: ["a", "b", "editor"], cursorRow: 2, cursorColumn: 0 });
    const written = tap(() => region.clear());
    expect(written).toContain("[2A"); // up to the region top
    expect(written).toContain("[J"); // clear to end of screen
  });
});
