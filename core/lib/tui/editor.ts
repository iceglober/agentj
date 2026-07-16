export type EditorCommand =
  | { type: "insert"; text: string }
  | { type: "newline" }
  | { type: "move-left" }
  | { type: "move-right" }
  | { type: "move-up" }
  | { type: "move-down" }
  | { type: "move-word-left" }
  | { type: "move-word-right" }
  | { type: "move-line-start" }
  | { type: "move-line-end" }
  | { type: "delete-backward" }
  | { type: "delete-forward" }
  | { type: "delete-word-backward" }
  | { type: "delete-word-forward" }
  | { type: "delete-line-backward" }
  | { type: "delete-line-forward" }
  | { type: "submit" }
  | { type: "cancel" }
  /** Screen-level keys (mode toggle, interrupt) — no-ops on the editor model. */
  | { type: "tab" }
  | { type: "escape" };

export interface EditorState {
  text: string;
  /** Cursor offset in grapheme clusters, not UTF-16 code units. */
  cursor: number;
  preferredColumn: number | null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const splitGraphemes = (value: string): string[] =>
  [...segmenter.segment(value)].map(({ segment }) => segment);

export const createEditorState = (text = ""): EditorState => {
  const graphemes = splitGraphemes(text);
  return { text, cursor: graphemes.length, preferredColumn: null };
};

const isWord = (grapheme: string): boolean => /[\p{Letter}\p{Number}\p{Mark}_]/u.test(grapheme);

const previousWord = (value: string[], cursor: number): number => {
  let target = cursor;
  while (target > 0 && !isWord(value[target - 1] ?? "")) target -= 1;
  while (target > 0 && isWord(value[target - 1] ?? "")) target -= 1;
  return target;
};

const nextWord = (value: string[], cursor: number): number => {
  let target = cursor;
  while (target < value.length && !isWord(value[target] ?? "")) target += 1;
  while (target < value.length && isWord(value[target] ?? "")) target += 1;
  return target;
};

const lineStart = (value: string[], cursor: number): number => {
  // Guard cursor 0: a negative fromIndex makes lastIndexOf search from the end.
  const newline = cursor <= 0 ? -1 : value.lastIndexOf("\n", cursor - 1);
  return newline + 1;
};

const lineEnd = (value: string[], cursor: number): number => {
  const newline = value.indexOf("\n", cursor);
  return newline === -1 ? value.length : newline;
};

const verticalTarget = (
  value: string[],
  cursor: number,
  direction: -1 | 1,
  preferredColumn: number | null,
): { cursor: number; preferredColumn: number } => {
  const start = lineStart(value, cursor);
  const column = preferredColumn ?? cursor - start;

  if (direction === -1) {
    if (start === 0) return { cursor, preferredColumn: column };
    const previousEnd = start - 1;
    const previousStart = lineStart(value, previousEnd);
    return {
      cursor: Math.min(previousStart + column, previousEnd),
      preferredColumn: column,
    };
  }

  const end = lineEnd(value, cursor);
  if (end === value.length) return { cursor, preferredColumn: column };
  const nextStart = end + 1;
  const nextEnd = lineEnd(value, nextStart);
  return {
    cursor: Math.min(nextStart + column, nextEnd),
    preferredColumn: column,
  };
};

const replaceRange = (
  value: string[],
  start: number,
  end: number,
  replacement: string[],
): EditorState => {
  const prefix = [...value.slice(0, start), ...replacement].join("");
  value.splice(start, end - start, ...replacement);
  return {
    text: value.join(""),
    cursor: splitGraphemes(prefix).length,
    preferredColumn: null,
  };
};

export const applyEditorCommand = (state: EditorState, command: EditorCommand): EditorState => {
  if (
    command.type === "submit" ||
    command.type === "cancel" ||
    command.type === "tab" ||
    command.type === "escape"
  ) {
    return state;
  }

  const value = splitGraphemes(state.text);
  const cursor = Math.max(0, Math.min(state.cursor, value.length));

  switch (command.type) {
    case "insert":
      return replaceRange(value, cursor, cursor, splitGraphemes(command.text));
    case "newline":
      return replaceRange(value, cursor, cursor, ["\n"]);
    case "move-left":
      return { ...state, cursor: Math.max(0, cursor - 1), preferredColumn: null };
    case "move-right":
      return { ...state, cursor: Math.min(value.length, cursor + 1), preferredColumn: null };
    case "move-up": {
      const target = verticalTarget(value, cursor, -1, state.preferredColumn);
      return { ...state, ...target };
    }
    case "move-down": {
      const target = verticalTarget(value, cursor, 1, state.preferredColumn);
      return { ...state, ...target };
    }
    case "move-word-left":
      return { ...state, cursor: previousWord(value, cursor), preferredColumn: null };
    case "move-word-right":
      return { ...state, cursor: nextWord(value, cursor), preferredColumn: null };
    case "move-line-start":
      return { ...state, cursor: lineStart(value, cursor), preferredColumn: null };
    case "move-line-end":
      return { ...state, cursor: lineEnd(value, cursor), preferredColumn: null };
    case "delete-backward":
      return cursor === 0 ? state : replaceRange(value, cursor - 1, cursor, []);
    case "delete-forward":
      return cursor === value.length ? state : replaceRange(value, cursor, cursor + 1, []);
    case "delete-word-backward":
      return replaceRange(value, previousWord(value, cursor), cursor, []);
    case "delete-word-forward":
      return replaceRange(value, cursor, nextWord(value, cursor), []);
    case "delete-line-backward":
      return replaceRange(value, lineStart(value, cursor), cursor, []);
    case "delete-line-forward":
      return replaceRange(value, cursor, lineEnd(value, cursor), []);
  }
};
