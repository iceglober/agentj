import { describe, expect, test } from "bun:test";
import { highlightEditorLine } from "./editor-highlighting";

describe("highlightEditorLine", () => {
  test("uses distinct semantic tones for slash and @ tokens", () => {
    expect(
      highlightEditorLine("> inspect /build and @src/main.ts", {
        background: false,
        firstRow: true,
      }),
    ).toEqual([
      { text: "> " },
      { text: "inspect " },
      { text: "/build", tone: "accent" },
      { text: " and " },
      { text: "@src/main.ts", tone: "success" },
    ]);
  });

  test("marks a leading background job without treating embedded & specially", () => {
    expect(highlightEditorLine("> & run tests", { background: true, firstRow: true })).toEqual([
      { text: "> ", tone: "warning", bold: true },
      { text: "&", tone: "warning", bold: true },
      { text: " run tests" },
    ]);
  });
});
