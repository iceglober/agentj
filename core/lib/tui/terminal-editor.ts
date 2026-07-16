import { type EditorState, splitGraphemes } from "./editor";

/**
 * Pure multiline layout for the raw-mode editor: prompt prefix, grapheme-aware
 * wrapping (East-Asian/emoji widths), and cursor placement. The chat screen
 * owns painting; this module owns geometry.
 */
interface RenderLayout {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
  finalColumn: number;
}

const graphemeWidth = (value: string): number => {
  if (/^\p{Mark}+$/u.test(value)) return 0;
  // VS-16 (U+FE0F) forces emoji presentation, rendered two cells wide.
  if (value.includes("\ufe0f")) return 2;
  const code = value.codePointAt(0) ?? 0;
  // Regional indicators (flag emoji like 🇺🇸) render two cells wide.
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return 2;
  // Symbols for Legacy Computing are East-Asian-Width Neutral (one cell).
  if (code >= 0x1fb00 && code <= 0x1fbff) return 1;
  if (
    code >= 0x1f300 ||
    (code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6)))
  ) {
    return 2;
  }
  return 1;
};

export const renderEditorLayout = (state: EditorState, terminalWidth: number): RenderLayout => {
  const width = Math.max(10, terminalWidth);
  const rows = ["> "];
  let column = 2;
  let cursorRow = 0;
  let cursorColumn = column;
  const graphemes = splitGraphemes(state.text);
  const cursor = Math.max(0, Math.min(state.cursor, graphemes.length));

  const captureCursor = (index: number): void => {
    if (index === cursor) {
      cursorRow = rows.length - 1;
      cursorColumn = column;
    }
  };

  for (const [index, grapheme] of graphemes.entries()) {
    captureCursor(index);
    if (grapheme === "\n") {
      rows.push("");
      column = 0;
      continue;
    }

    const rendered = grapheme === "\t" ? " ".repeat(4 - (column % 4)) : grapheme;
    const cellWidth = grapheme === "\t" ? rendered.length : graphemeWidth(grapheme);
    if (column > 0 && column + cellWidth > width) {
      rows.push("");
      column = 0;
      captureCursor(index);
    }
    rows[rows.length - 1] += rendered;
    column += cellWidth;
  }
  captureCursor(graphemes.length);

  return { rows, cursorRow, cursorColumn, finalColumn: column };
};
