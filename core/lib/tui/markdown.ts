import type { UiBlock, UiLine, UiSpan } from "./styles";

/** Small semantic terminal markdown. ANSI is deliberately emitted only by the screen. */
const inline = (line: string): UiLine => {
  const spans: UiSpan[] = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*`])\*([^*\s][^*]*)\*(?![\w*])|`([^`]+)`)/gu;
  let offset = 0;
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > offset) spans.push({ text: line.slice(offset, start) });
    if (match[2] !== undefined || match[3] !== undefined) {
      spans.push({ text: match[2] ?? match[3] ?? "", bold: true });
    } else if (match[4] !== undefined) {
      spans.push({ text: match[4], italic: true });
    } else {
      spans.push({ text: match[5] ?? "", tone: "accent" });
    }
    offset = start + match[0].length;
  }
  if (offset < line.length || spans.length === 0) spans.push({ text: line.slice(offset) });
  return spans;
};

export function renderMarkdownLite(text: string): UiBlock {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      return [{ text: line, tone: "muted" }];
    }
    if (inFence) return [{ text: line }];
    const header = line.match(/^#{1,4}\s+(.*)$/u);
    if (header) return [{ text: header[1] ?? "", bold: true, underline: true }];
    return inline(line);
  });
}
