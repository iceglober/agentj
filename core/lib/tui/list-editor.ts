export interface ListEditorState {
  items: string[];
  cursor: number;
}

export type ListEditorAction =
  | { type: "add"; item: string }
  | { type: "edit"; item: string }
  | { type: "delete" }
  // Move the selection.
  | { type: "move-up" }
  | { type: "move-down" }
  // Reorder the selected item (order is meaningful, e.g. the tier ladder).
  | { type: "reorder-up" }
  | { type: "reorder-down" };

/** Swap the item at `cursor` with its neighbor `delta` away; cursor follows it. */
const swap = (state: ListEditorState, delta: number): ListEditorState => {
  const cursor = cursorFor(state.cursor, state.items.length);
  const target = cursor + delta;
  if (target < 0 || target >= state.items.length) return { items: [...state.items], cursor };
  const items = [...state.items];
  [items[cursor], items[target]] = [items[target], items[cursor]];
  return { items, cursor: target };
};

const cursorFor = (cursor: number, length: number): number =>
  length === 0 ? 0 : Math.max(0, Math.min(cursor, length - 1));

/** Apply one list-editing action without any terminal or input dependencies. */
export function reduceListEditor(
  state: ListEditorState,
  action: ListEditorAction,
): ListEditorState {
  const cursor = cursorFor(state.cursor, state.items.length);
  if (action.type === "add") {
    return { items: [...state.items, action.item], cursor: state.items.length };
  }
  if (action.type === "edit") {
    if (state.items.length === 0) return { items: [...state.items], cursor };
    const items = [...state.items];
    items[cursor] = action.item;
    return { items, cursor };
  }
  if (action.type === "delete") {
    if (state.items.length === 0) return { items: [], cursor: 0 };
    const items = state.items.filter((_, index) => index !== cursor);
    return { items, cursor: cursorFor(cursor, items.length) };
  }
  if (action.type === "move-up") {
    return { items: [...state.items], cursor: cursorFor(cursor - 1, state.items.length) };
  }
  if (action.type === "move-down") {
    return { items: [...state.items], cursor: cursorFor(cursor + 1, state.items.length) };
  }
  return swap(state, action.type === "reorder-up" ? -1 : 1);
}
