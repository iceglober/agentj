import { describe, expect, test } from "bun:test";

import { createEditorState } from "./editor";
import { renderEditorLayout } from "./terminal-editor";

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
});
