import { splitGraphemes } from "./editor";
import { findEditorTokens } from "./editor-completion";
import type { UiLine } from "./styles";

/** Apply semantic editor colors without putting ANSI into editor state or layout. */
export const highlightEditorLine = (
  row: string,
  options: { background: boolean; firstRow: boolean },
): UiLine => {
  const prefix = options.firstRow && row.startsWith("> ") ? "> " : "";
  const content = prefix ? row.slice(prefix.length) : row;
  const graphemes = splitGraphemes(content);
  const spans: UiLine[number][] = [];
  if (prefix)
    spans.push({ text: prefix, ...(options.background ? { tone: "warning", bold: true } : {}) });

  let offset = 0;
  for (const token of findEditorTokens(content)) {
    if (token.start > offset) spans.push({ text: graphemes.slice(offset, token.start).join("") });
    spans.push({
      text: graphemes.slice(token.start, token.end).join(""),
      tone: token.sigil === "/" ? "accent" : "success",
    });
    offset = token.end;
  }
  if (offset < graphemes.length || spans.length === 0)
    spans.push({ text: graphemes.slice(offset).join("") });

  if (options.background && options.firstRow && content.startsWith("&")) {
    const contentSpanIndex = prefix ? 1 : 0;
    const span = spans[contentSpanIndex];
    if (span) {
      const tail = span.text.slice(1);
      spans.splice(
        contentSpanIndex,
        1,
        { text: "&", tone: "warning", bold: true },
        ...(tail ? [{ text: tail, tone: span.tone }] : []),
      );
    }
  }
  return spans;
};
