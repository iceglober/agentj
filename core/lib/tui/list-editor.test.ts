import { describe, expect, test } from "bun:test";
import { reduceListEditor } from "./list-editor";

describe("reduceListEditor", () => {
  test("adds an item and selects it", () => {
    expect(reduceListEditor({ items: ["one"], cursor: 0 }, { type: "add", item: "two" })).toEqual({
      items: ["one", "two"],
      cursor: 1,
    });
  });

  test("edits the selected item", () => {
    expect(
      reduceListEditor({ items: ["one", "two"], cursor: 1 }, { type: "edit", item: "new" }),
    ).toEqual({
      items: ["one", "new"],
      cursor: 1,
    });
  });

  test("deletes the selected item and keeps the cursor in bounds", () => {
    expect(reduceListEditor({ items: ["one", "two"], cursor: 1 }, { type: "delete" })).toEqual({
      items: ["one"],
      cursor: 0,
    });
  });

  test("moves the cursor up and down within bounds", () => {
    expect(reduceListEditor({ items: ["one", "two"], cursor: 0 }, { type: "move-up" })).toEqual({
      items: ["one", "two"],
      cursor: 0,
    });
    expect(reduceListEditor({ items: ["one", "two"], cursor: 0 }, { type: "move-down" })).toEqual({
      items: ["one", "two"],
      cursor: 1,
    });
    expect(reduceListEditor({ items: ["one", "two"], cursor: 1 }, { type: "move-down" })).toEqual({
      items: ["one", "two"],
      cursor: 1,
    });
  });

  test("keeps empty-list actions in bounds", () => {
    expect(reduceListEditor({ items: [], cursor: 4 }, { type: "edit", item: "new" })).toEqual({
      items: [],
      cursor: 0,
    });
    expect(reduceListEditor({ items: [], cursor: 4 }, { type: "delete" })).toEqual({
      items: [],
      cursor: 0,
    });
  });
});

test("reorder-up swaps the selected item toward the front and follows it", () => {
  const start = { items: ["a", "b", "c"], cursor: 2 };
  const moved = reduceListEditor(start, { type: "reorder-up" });
  expect(moved).toEqual({ items: ["a", "c", "b"], cursor: 1 });
});

test("reorder-down swaps toward the back; a boundary is a no-op", () => {
  expect(reduceListEditor({ items: ["a", "b"], cursor: 0 }, { type: "reorder-down" })).toEqual({
    items: ["b", "a"],
    cursor: 1,
  });
  expect(reduceListEditor({ items: ["a", "b"], cursor: 1 }, { type: "reorder-down" })).toEqual({
    items: ["a", "b"],
    cursor: 1,
  });
});
