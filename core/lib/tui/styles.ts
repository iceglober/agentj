import { splitGraphemes } from "./editor";
import { displayWidth, escapeTerminalText, graphemeWidth } from "./terminal-editor";

/** Semantic terminal styling. Text is always escaped before ANSI is emitted. */
export type UiTone = "accent" | "muted" | "success" | "warning" | "danger";

export interface UiSpan {
  text: string;
  tone?: UiTone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type UiLine = readonly UiSpan[];
export type UiBlock = readonly UiLine[];
export type UiTextLine = string | UiLine;

const RESET = "\u001b[0m";
const toneCodes: Record<UiTone, string> = {
  accent: "\u001b[36m",
  muted: "\u001b[2m",
  success: "\u001b[32m",
  warning: "\u001b[33m",
  danger: "\u001b[31m",
};

const normalize = (line: UiTextLine): UiLine =>
  typeof line === "string" ? [{ text: line }] : line;

const styled = (span: UiSpan, text: string, color: boolean): string => {
  if (!color || text.length === 0) return text;
  const codes = [
    span.bold ? "\u001b[1m" : "",
    span.italic ? "\u001b[3m" : "",
    span.underline ? "\u001b[4m" : "",
    span.tone ? toneCodes[span.tone] : "",
  ].join("");
  return codes.length > 0 ? `${codes}${text}${RESET}` : text;
};

export const createTerminalStyler = (options: { color: boolean }) => {
  const renderLine = (line: UiTextLine, maxWidth?: number): string => {
    const spans = normalize(line).map((span) => ({
      ...span,
      text: escapeTerminalText(span.text).replace(/\n+/gu, " "),
    }));
    const limit =
      maxWidth === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(maxWidth));
    const truncated = spans.reduce((total, span) => total + displayWidth(span.text), 0) > limit;
    if (limit === 0) return "";
    const contentLimit = truncated ? limit - 1 : limit;
    let width = 0;
    let output = "";
    for (const span of spans) {
      let rendered = "";
      for (const grapheme of splitGraphemes(span.text)) {
        const cellWidth = graphemeWidth(grapheme);
        if (width + cellWidth > contentLimit) break;
        rendered += grapheme;
        width += cellWidth;
      }
      output += styled(span, rendered, options.color);
      if (width >= contentLimit) break;
    }
    return truncated ? `${output}…` : output;
  };

  const renderBlock = (text: string | UiBlock): string[] =>
    typeof text === "string"
      ? text.split("\n").map((line) => renderLine(line))
      : text.map((line) => renderLine(line));

  return { renderLine, renderBlock };
};
