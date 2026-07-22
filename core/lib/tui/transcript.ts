import type { UiBlock, UiLine } from "./styles";
import { displayWidth, wrapToDisplayWidth } from "./terminal-editor";

/**
 * Word-wrap a dim reflection block to the render width so wrapped lines don't
 * rely on terminal soft-wrap (which drops the source line's leading indent).
 * Each source line keeps its own leading whitespace on every continuation, so
 * an indented line stays visually hanging under its first character.
 */
export const wrapMutedBlock = (text: string, width?: number): UiBlock => {
  const block: UiLine[] = [];
  for (const line of text.split("\n")) {
    const indent = /^\s*/u.exec(line)?.[0] ?? "";
    const body = line.slice(indent.length);
    if (width === undefined || width <= 0 || body.length === 0) {
      block.push([{ text: line, tone: "muted" }]);
      continue;
    }
    const avail = Math.max(1, Math.floor(width) - displayWidth(indent));
    for (const chunk of wrapWords(body, avail))
      block.push([{ text: `${indent}${chunk}`, tone: "muted" }]);
  }
  return block;
};

/** Greedy word wrap by display width; a single over-long word is hard-broken. */
const wrapWords = (body: string, avail: number): string[] => {
  const words = body.split(/\s+/u).filter((word) => word.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (displayWidth(word) > avail) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      const pieces = wrapToDisplayWidth(word, avail);
      chunks.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? "";
      continue;
    }
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (displayWidth(candidate) > avail) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
};

/** Format one user turn as semantic terminal lines. When a width is given, each
 *  line is padded out with background-colored spaces so the muted block reads as
 *  a solid rectangle — the blank padding rows and the gap to the right of the
 *  text included — instead of only tinting the cells under the glyphs. */
export const formatUserTurnBlock = (
  text: string,
  transcriptText?: string,
  width?: number,
): UiBlock => {
  if (transcriptText !== undefined) return wrapMutedBlock(transcriptText, width);

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
