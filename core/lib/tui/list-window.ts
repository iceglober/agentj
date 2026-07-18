/**
 * Stateless viewport over a selectable list: every list surface the screen
 * paints (slash completions, guided-input choices, any future picker) renders
 * through this one primitive, so "more items than rows" always means a window
 * that follows the selection — never a truncation that makes items
 * unreachable. Navigation happens over the full list; only painting windows.
 */

export interface ListWindow<T> {
  /** Index into the full list of the first visible item. */
  start: number;
  items: readonly T[];
  omittedAbove: number;
  omittedBelow: number;
}

/** Rows a windowed list may occupy in the live region (excluding overflow markers). */
export const LIST_WINDOW_ROWS = 7;

/**
 * The window keeps the selection centered once the list scrolls, clamped at
 * both ends. Centering is deterministic from (selection, length) alone, so
 * repaints need no retained scroll state.
 */
export function windowList<T>(
  items: readonly T[],
  selectedIndex: number,
  capacity: number = LIST_WINDOW_ROWS,
): ListWindow<T> {
  const rows = Math.max(1, Math.floor(capacity));
  if (items.length <= rows) {
    return { start: 0, items, omittedAbove: 0, omittedBelow: 0 };
  }
  const selected = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const start = Math.max(0, Math.min(selected - Math.floor((rows - 1) / 2), items.length - rows));
  return {
    start,
    items: items.slice(start, start + rows),
    omittedAbove: start,
    omittedBelow: items.length - (start + rows),
  };
}

/**
 * One footer row for a scrolled window: `  … ↑ 7 · ↓ 6 more`. A windowed list
 * always omits at least one side, so the footer is present for the whole life
 * of a scrolled list and only its counts change — separate above/below marker
 * rows toggled with the scroll position, changing the menu's height and
 * bouncing everything around it as the selection moved.
 */
export const listOverflowFooter = <T>(window: ListWindow<T>): string | null => {
  const sides = [
    ...(window.omittedAbove > 0 ? [`↑ ${window.omittedAbove}`] : []),
    ...(window.omittedBelow > 0 ? [`↓ ${window.omittedBelow}`] : []),
  ];
  return sides.length === 0 ? null : `  … ${sides.join(" · ")} more`;
};
