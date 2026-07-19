import { type EditorState, splitGraphemes } from "./editor";

/**
 * Pure multiline layout for the raw-mode editor: prompt prefix, grapheme-aware
 * wrapping (East-Asian/emoji widths), and cursor placement. The chat screen
 * owns painting; this module owns geometry.
 */
export interface RenderLayout {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
  finalColumn: number;
}

/**
 * Keep the active cursor visible in a bounded editor viewport. Layout stays
 * pure: the screen can repaint the returned rows without retaining scroll
 * state or knowing wrapping details.
 */
export const windowEditorLayout = (layout: RenderLayout, maxRows: number): RenderLayout => {
  const size = Math.max(1, Math.floor(maxRows));
  if (layout.rows.length <= size) return layout;
  const start = Math.max(
    0,
    Math.min(layout.rows.length - size, layout.cursorRow - Math.floor(size / 2)),
  );
  return {
    ...layout,
    rows: layout.rows.slice(start, start + size),
    cursorRow: layout.cursorRow - start,
  };
};

export const graphemeWidth = (value: string): number => {
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

/** SGR is emitted only by the TUI style boundary and occupies no terminal cells. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips trusted ANSI SGR emitted by styles.ts
const stripSgr = (value: string): string => value.replace(/\u001b\[[0-9;]*m/gu, "");

export const displayWidth = (value: string): number =>
  splitGraphemes(stripSgr(value)).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0);

const escapeCodePoint = (value: string): string => {
  const code = value.codePointAt(0) ?? 0;
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
};

/** Neutralize terminal controls while retaining line breaks for transcript layout. */
export const escapeTerminalText = (value: string): string =>
  value
    .replace(/\r\n?/gu, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being escaped
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, escapeCodePoint)
    .replace(/\p{Bidi_Control}/gu, escapeCodePoint);

export const truncateToDisplayWidth = (value: string, maxWidth: number): string => {
  const width = Math.max(0, Math.floor(maxWidth));
  if (displayWidth(value) <= width) return value;
  if (width === 0) return "";

  const target = width - 1;
  let rendered = "";
  let column = 0;
  for (const grapheme of splitGraphemes(value)) {
    const cellWidth = graphemeWidth(grapheme);
    if (column + cellWidth > target) break;
    rendered += grapheme;
    column += cellWidth;
  }
  return `${rendered}…`;
};

export const wrapToDisplayWidth = (value: string, maxWidth: number): string[] => {
  const width = Math.max(1, Math.floor(maxWidth));
  const rows = [""];
  let column = 0;

  for (const grapheme of splitGraphemes(value)) {
    if (grapheme === "\n") {
      rows.push("");
      column = 0;
      continue;
    }
    const cellWidth = graphemeWidth(grapheme);
    if (column > 0 && column + cellWidth > width) {
      rows.push("");
      column = 0;
    }
    if (cellWidth > width) {
      rows[rows.length - 1] += "?";
      column += 1;
    } else {
      rows[rows.length - 1] += grapheme;
      column += cellWidth;
    }
  }
  return rows;
};

export const renderEditorLayout = (state: EditorState, terminalWidth: number): RenderLayout => {
  const width = Math.max(1, Math.floor(terminalWidth));
  const prefix = width === 1 ? ">" : "> ";
  const rows = [prefix];
  let column = displayWidth(prefix);
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

    let rendered = grapheme === "\t" ? " ".repeat(4 - (column % 4)) : grapheme;
    let cellWidth = grapheme === "\t" ? rendered.length : graphemeWidth(grapheme);
    if (cellWidth > width) {
      rendered = grapheme === "\t" ? " ".repeat(width) : "?";
      cellWidth = rendered.length;
    }
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
