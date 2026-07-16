import type { Readable, Writable } from "node:stream";

import { applyEditorCommand, createEditorState, type EditorState, splitGraphemes } from "./editor";
import { TerminalKeyDecoder } from "./key-decoder";
import type { TextPromptEditor, TextPromptRequest } from "./prompt-input";

interface RawTerminalInput extends Readable {
  isRaw?: boolean;
  setRawMode?(mode: boolean): this;
}

interface TerminalOutput extends Writable {
  columns?: number;
}

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

const cursorForward = (columns: number): string => (columns > 0 ? `\u001b[${columns}C` : "");
const cursorUp = (rows: number): string => (rows > 0 ? `\u001b[${rows}A` : "");
const cursorDown = (rows: number): string => (rows > 0 ? `\u001b[${rows}B` : "");

export interface CreateTerminalPromptEditorOptions {
  stdin?: Readable;
  stdout?: Writable;
  terminalWidth?: number | (() => number);
}

export const createTerminalPromptEditor = (
  defaults: CreateTerminalPromptEditorOptions = {},
): TextPromptEditor => ({
  read(request: TextPromptRequest): Promise<string | null> {
    const stdin = (request.stdin ?? defaults.stdin ?? process.stdin) as RawTerminalInput;
    const stdout = (request.stdout ?? defaults.stdout ?? process.stdout) as TerminalOutput;
    const configuredWidth = defaults.terminalWidth;
    const width = (): number =>
      Math.max(
        10,
        typeof configuredWidth === "function"
          ? configuredWidth()
          : (configuredWidth ?? stdout.columns ?? 80),
      );

    if (stdin.destroyed || stdin.readableEnded) return Promise.resolve(null);

    return new Promise<string | null>((resolve, reject) => {
      const decoder = new TerminalKeyDecoder();
      let state = createEditorState();
      let layout: RenderLayout | undefined;
      let settled = false;
      const wasPaused = stdin.isPaused();
      const previousRawMode = stdin.isRaw === true;
      let rawModeChanged = false;

      const write = (text: string): void => {
        stdout.write(text);
      };

      const paint = (): void => {
        const next = renderEditorLayout(state, width());
        if (layout) write(`\r${cursorUp(layout.cursorRow)}\u001b[J`);
        write(next.rows.join("\r\n"));
        write(
          `\r${cursorUp(next.rows.length - 1 - next.cursorRow)}${cursorForward(next.cursorColumn)}`,
        );
        layout = next;
      };

      const cleanup = (): unknown => {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
        stdin.removeListener("error", onInputError);
        stdout.removeListener("error", onOutputError);
        let cleanupError: unknown;
        if (rawModeChanged) {
          try {
            stdin.setRawMode?.(previousRawMode);
          } catch (error) {
            cleanupError = error;
          }
        }
        if (wasPaused) stdin.pause();
        return cleanupError;
      };

      const finish = (value: string | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          if (layout) {
            write(`${cursorDown(layout.rows.length - 1 - layout.cursorRow)}\r\n`);
          }
        } catch (writeError) {
          error ??= writeError;
        }
        const cleanupError = cleanup();
        error ??= cleanupError;
        if (error !== undefined) reject(error);
        else resolve(value);
      };

      const apply = (commands: ReturnType<TerminalKeyDecoder["push"]>): void => {
        for (const command of commands) {
          if (command.type === "submit") {
            paint();
            finish(state.text);
            return;
          }
          if (command.type === "cancel") {
            paint();
            finish(null);
            return;
          }
          state = applyEditorCommand(state, command);
        }
        if (!settled) paint();
      };

      function onData(chunk: string | Buffer): void {
        try {
          apply(decoder.push(chunk));
        } catch (error) {
          finish(null, error);
        }
      }

      function onEnd(): void {
        try {
          apply(decoder.end());
          if (!settled) finish(null);
        } catch (error) {
          finish(null, error);
        }
      }

      function onInputError(error: Error): void {
        finish(null, error);
      }

      function onOutputError(error: Error): void {
        finish(null, error);
      }

      stdin.on("data", onData);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
      stdin.once("error", onInputError);
      stdout.once("error", onOutputError);

      try {
        if (request.validationMessage) write(`! ${request.validationMessage}\n`);
        write(`${request.message}\n  ${request.hint}\n`);
        paint();
        if (stdin.setRawMode && !previousRawMode) {
          stdin.setRawMode(true);
          rawModeChanged = true;
        }
        stdin.resume();
      } catch (error) {
        finish(null, error);
      }
    });
  },
});
