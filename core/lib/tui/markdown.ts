/**
 * Deliberately small terminal markdown: bold, italic, inline code, headers,
 * and dimmed code fences — the constructs models actually emit in chat. Not a
 * parser; line-oriented regex transforms. Callers gate on TTY (the plain text
 * passes through untouched everywhere else).
 */

const BOLD = "\u001b[1m";
const ITALIC = "\u001b[3m";
const UNDERLINE = "\u001b[4m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

const renderInline = (line: string): string =>
  line
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
    .replace(/__([^_]+)__/g, `${BOLD}$1${RESET}`)
    .replace(/(?<![\w*`])\*([^*\s][^*]*)\*(?![\w*])/g, `${ITALIC}$1${RESET}`)
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);

export function renderMarkdownLite(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return `${DIM}${line}${RESET}`;
      }
      if (inFence) return line; // code verbatim
      const header = line.match(/^#{1,4}\s+(.*)$/);
      if (header) return `${BOLD}${UNDERLINE}${header[1]}${RESET}`;
      return renderInline(line);
    })
    .join("\n");
}
