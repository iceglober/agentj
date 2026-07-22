import type { UiBlock, UiLine } from "./styles";
import { displayWidth } from "./terminal-editor";

/** Format one user turn as semantic terminal lines. When a width is given, each
 *  line is padded out with background-colored spaces so the muted block reads as
 *  a solid rectangle — the blank padding rows and the gap to the right of the
 *  text included — instead of only tinting the cells under the glyphs. */
export const formatUserTurnBlock = (
  text: string,
  transcriptText?: string,
  width?: number,
): UiBlock => {
  if (transcriptText !== undefined)
    return transcriptText.split("\n").map((line) => [{ text: line, tone: "muted" as const }]);

  const background = { background: "muted" as const };
  const fill = (line: UiLine): UiLine => {
    if (width === undefined) return line;
    const used = line.reduce((total, span) => total + displayWidth(span.text), 0);
    const gap = Math.max(0, Math.floor(width) - used);
    return gap > 0 ? [...line, { text: " ".repeat(gap), ...background }] : line;
  };

  const paddingRow = fill([{ text: " ", ...background }]);
  const lines = text.split("\n").map((line, index) =>
    fill(
      index === 0
        ? [
            { text: " ", ...background },
            { text: "❯", tone: "accent" as const, bold: true, ...background },
            { text: " ", ...background },
            { text: line, bold: true, ...background },
            { text: " ", ...background },
          ]
        : [{ text: ` ${line} `, bold: true, ...background }],
    ),
  );
  return [paddingRow, ...lines, paddingRow];
};
