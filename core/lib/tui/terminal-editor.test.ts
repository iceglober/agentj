import { describe, expect, test } from "bun:test";

import { createEditorState } from "./editor";
import {
  displayWidth,
  renderEditorLayout,
  truncateToDisplayWidth,
  windowEditorLayout,
  wrapToDisplayWidth,
} from "./terminal-editor";

describe("renderEditorLayout", () => {
  test("lays out wrapped and explicit multiline content at the active cursor", () => {
    expect(renderEditorLayout(createEditorState("123456789"), 10)).toEqual({
      rows: ["> 12345678", "9"],
      cursorRow: 1,
      cursorColumn: 1,
      finalColumn: 1,
    });
    expect(renderEditorLayout({ ...createEditorState("ab\ncdef"), cursor: 4 }, 20)).toMatchObject({
      rows: ["> ab", "cdef"],
      cursorRow: 1,
      cursorColumn: 1,
    });
  });

  test("sizes flag and VS-16 emoji two cells wide and legacy-computing symbols one", () => {
    expect(renderEditorLayout(createEditorState("🇺🇸"), 80).cursorColumn).toBe(4);
    expect(renderEditorLayout(createEditorState("❤️"), 80).cursorColumn).toBe(4);
    expect(renderEditorLayout(createEditorState("\u{1fb00}"), 80).cursorColumn).toBe(3);
  });

  test("wraps and truncates text without exceeding display-cell widths", () => {
    expect(displayWidth("a🙂界")).toBe(5);
    expect(truncateToDisplayWidth("ab🙂cd", 4)).toBe("ab…");
    const rows = wrapToDisplayWidth("ab🙂界c", 3);
    expect(rows).toEqual(["ab", "🙂", "界c"]);
    expect(rows.every((row) => displayWidth(row) <= 3)).toBe(true);
  });

  test("keeps editor rows inside narrow terminal widths", () => {
    const layout = renderEditorLayout(createEditorState("ab🙂\tcd"), 3);
    expect(layout.rows.every((row) => displayWidth(row) <= 3)).toBe(true);
  });

  test("windows long editor layouts around the cursor", () => {
    const layout = renderEditorLayout(createEditorState("one\ntwo\nthree\nfour\nfive"), 20);
    const atEnd = windowEditorLayout(layout, 3);
    expect(atEnd.rows).toEqual(["three", "four", "five"]);
    expect(atEnd.cursorRow).toBe(2);

    const nearTop = windowEditorLayout({ ...layout, cursorRow: 0 }, 3);
    expect(nearTop.rows).toEqual(["> one", "two", "three"]);
    expect(nearTop.cursorRow).toBe(0);
  });
});
