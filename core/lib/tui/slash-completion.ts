import { type EditorState, splitGraphemes } from "./editor";

export interface SlashCommandToken {
  /** Grapheme offsets spanning the slash and command name, excluding whitespace. */
  start: number;
  end: number;
  query: string;
}

/** Find the initial slash-command token when the cursor is editing that token. */
export function findSlashCommandToken(state: EditorState): SlashCommandToken | null {
  const value = splitGraphemes(state.text);
  const cursor = Math.max(0, Math.min(state.cursor, value.length));
  const start = value.findIndex((grapheme) => !/^\s$/u.test(grapheme));
  if (start === -1 || value[start] !== "/") return null;

  let end = start + 1;
  while (end < value.length && !/^\s$/u.test(value[end] ?? "")) end += 1;
  if (cursor <= start || cursor > end) return null;

  return {
    start,
    end,
    query: value.slice(start + 1, end).join(""),
  };
}
