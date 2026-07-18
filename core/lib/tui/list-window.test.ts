import { describe, expect, test } from "bun:test";
import { LIST_WINDOW_ROWS, listOverflowMarkers, windowList } from "./list-window";

const items = (count: number): string[] => Array.from({ length: count }, (_, i) => `item-${i}`);

describe("windowList", () => {
  test("short lists pass through whole with no overflow", () => {
    const window = windowList(items(7), 3);
    expect(window.items).toHaveLength(7);
    expect(window.start).toBe(0);
    expect(window.omittedAbove).toBe(0);
    expect(window.omittedBelow).toBe(0);
  });

  test("long lists clamp to the top until the selection passes center", () => {
    const window = windowList(items(20), 0);
    expect(window.start).toBe(0);
    expect(window.items).toHaveLength(LIST_WINDOW_ROWS);
    expect(window.omittedBelow).toBe(13);
  });

  test("the window centers the selection mid-list", () => {
    const window = windowList(items(20), 10);
    expect(window.start).toBe(7); // selection sits at the center row
    expect(window.items[10 - window.start]).toBe("item-10");
    expect(window.omittedAbove).toBe(7);
    expect(window.omittedBelow).toBe(6);
  });

  test("the window clamps at the bottom so the last rows fill completely", () => {
    const window = windowList(items(20), 19);
    expect(window.start).toBe(13);
    expect(window.items.at(-1)).toBe("item-19");
    expect(window.omittedAbove).toBe(13);
    expect(window.omittedBelow).toBe(0);
  });

  test("every index of a long list is visible in its own window", () => {
    const all = items(40);
    for (let index = 0; index < all.length; index += 1) {
      const window = windowList(all, index);
      expect(window.items).toContain(`item-${index}`);
    }
  });

  test("out-of-range selections clamp instead of throwing", () => {
    expect(windowList(items(20), 99).items.at(-1)).toBe("item-19");
    expect(windowList(items(20), -5).start).toBe(0);
    expect(windowList([], 0).items).toHaveLength(0);
  });
});

describe("listOverflowMarkers", () => {
  test("markers appear only for the sides that actually overflow", () => {
    expect(listOverflowMarkers(windowList(items(5), 0))).toEqual({ above: null, below: null });
    expect(listOverflowMarkers(windowList(items(20), 0))).toEqual({
      above: null,
      below: "  … ↓ 13 more",
    });
    expect(listOverflowMarkers(windowList(items(20), 10))).toEqual({
      above: "  … ↑ 7 more",
      below: "  … ↓ 6 more",
    });
  });
});
