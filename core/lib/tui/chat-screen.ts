import type { Readable, Writable } from "node:stream";
import type { PermissionRequest } from "../agent/permissions";
import { applyEditorCommand, createEditorState, type EditorState } from "./editor";
import { TerminalKeyDecoder } from "./key-decoder";
import { renderEditorLayout } from "./terminal-editor";

/**
 * The persistent chat surface: raw mode for the whole session, one live
 * region at the bottom (optional progress block → editor rows → status line)
 * repainted in place, and an append-only transcript printed above it — the
 * same cursor-up/clear/repaint trick the DAG painter proved, generalized.
 * The screen renders and routes keys; it decides nothing (ChatSession does).
 */

interface RawInput extends Readable {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?(mode: boolean): this;
}

interface TerminalOutput extends Writable {
  columns?: number;
}

export interface ChatScreenCallbacks {
  onSubmit(text: string): void;
  onTab(): void;
  onEscape(): void;
  /** Double Ctrl+C on an empty editor. */
  onQuit(): void;
}

export interface CreateChatScreenOptions {
  stdin?: Readable;
  stdout?: Writable;
  terminalWidth?: number | (() => number);
  callbacks: ChatScreenCallbacks;
  /** Bare-ESC resolution delay; tests shrink it. */
  escapeFlushMs?: number;
  /** Double-Ctrl+C exit window. */
  quitWindowMs?: number;
}

export interface ChatScreen {
  start(): void;
  stop(): void;
  /** Append transcript output above the live region. */
  printAbove(text: string): void;
  /** Replace the progress block (empty array hides it). */
  setProgressLines(lines: string[]): void;
  setStatus(text: string): void;
  /** Modal single-key permission prompt in the live region. */
  askPermission(request: PermissionRequest): Promise<"allow" | "deny">;
}

export function createChatScreen(options: CreateChatScreenOptions): ChatScreen {
  const stdin = (options.stdin ?? process.stdin) as RawInput;
  const stdout = (options.stdout ?? process.stdout) as TerminalOutput;
  const width = (): number =>
    Math.max(
      20,
      typeof options.terminalWidth === "function"
        ? options.terminalWidth()
        : (options.terminalWidth ?? stdout.columns ?? 80),
    );

  const decoder = new TerminalKeyDecoder();
  let editor: EditorState = createEditorState();
  let progressLines: string[] = [];
  let status = "";
  let liveLineCount = 0;
  let started = false;
  let previousRawMode = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;
  let quitArmedAt = 0;
  let pendingAsk: {
    request: PermissionRequest;
    resolve: (decision: "allow" | "deny") => void;
  } | null = null;

  const write = (text: string): void => {
    stdout.write(text);
  };

  const liveLines = (): { lines: string[]; cursorRow: number; cursorColumn: number } => {
    if (pendingAsk) {
      const { request } = pendingAsk;
      const ask = `Permission ${request.tool}: ${request.detail.slice(0, width() - 30)} — [y]es once · [a]lways · [n]o`;
      return {
        lines: [...progressLines, ask, status],
        cursorRow: progressLines.length,
        cursorColumn: ask.length,
      };
    }
    const layout = renderEditorLayout(editor, width());
    return {
      lines: [...progressLines, ...layout.rows, status],
      cursorRow: progressLines.length + layout.cursorRow,
      cursorColumn: layout.cursorColumn,
    };
  };

  const csi = (sequence: string): string => `\u001b[${sequence}`;

  const paint = (): void => {
    const { lines, cursorRow, cursorColumn } = liveLines();
    // CSI 0A means "up 1" on many terminals, so guard the single-line case.
    if (liveLineCount > 1) write(csi(`${liveLineCount - 1}A`));
    write(`\r${csi("J")}`);
    write(lines.join("\r\n"));
    const up = lines.length - 1 - cursorRow;
    write(`\r${up > 0 ? csi(`${up}A`) : ""}${cursorColumn > 0 ? csi(`${cursorColumn}C`) : ""}`);
    liveLineCount = lines.length;
  };

  const clearLive = (): void => {
    if (liveLineCount > 1) write(csi(`${liveLineCount - 1}A`));
    if (liveLineCount > 0) write(`\r${csi("J")}`);
    liveLineCount = 0;
  };

  const armEscapeFlush = (): void => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      if (decoder.flush().length > 0) options.callbacks.onEscape();
    }, options.escapeFlushMs ?? 40);
  };

  const handleAskKey = (command: { type: string; text?: string }): void => {
    if (!pendingAsk) return;
    const key = command.type === "insert" ? command.text?.toLowerCase() : null;
    const decision =
      key === "y" || key === "a"
        ? "allow"
        : key === "n" || command.type === "cancel"
          ? "deny"
          : null;
    if (!decision) return;
    const ask = pendingAsk;
    pendingAsk = null;
    paint();
    ask.resolve(decision);
  };

  const handleCommand = (command: ReturnType<TerminalKeyDecoder["push"]>[number]): void => {
    if (pendingAsk) {
      handleAskKey(command);
      return;
    }
    switch (command.type) {
      case "tab":
        options.callbacks.onTab();
        return;
      case "escape":
        options.callbacks.onEscape();
        return;
      case "submit": {
        const text = editor.text;
        if (text.trim().length === 0) return;
        editor = createEditorState();
        paint();
        options.callbacks.onSubmit(text);
        return;
      }
      case "cancel": {
        if (editor.text.length > 0) {
          editor = createEditorState();
          paint();
          return;
        }
        const now = Date.now();
        if (now - quitArmedAt < (options.quitWindowMs ?? 1500)) {
          options.callbacks.onQuit();
          return;
        }
        quitArmedAt = now;
        options.callbacks.onEscape(); // Ctrl+C on empty editor also interrupts a turn
        return;
      }
      default:
        editor = applyEditorCommand(editor, command);
        paint();
    }
  };

  const onData = (chunk: string | Buffer): void => {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    for (const command of decoder.push(chunk)) handleCommand(command);
    if (decoder.pendingLoneEscape) armEscapeFlush();
  };

  return {
    start() {
      if (started) return;
      started = true;
      previousRawMode = stdin.isRaw === true;
      stdin.on("data", onData);
      if (stdin.setRawMode && !previousRawMode) stdin.setRawMode(true);
      stdin.resume?.();
      paint();
    },

    stop() {
      if (!started) return;
      started = false;
      if (escapeTimer) clearTimeout(escapeTimer);
      stdin.removeListener("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(previousRawMode);
      clearLive();
      write("\r\n");
    },

    printAbove(text) {
      clearLive();
      write(`${text.split("\n").join("\r\n")}\r\n`);
      paint();
    },

    setProgressLines(lines) {
      progressLines = lines;
      paint();
    },

    setStatus(text) {
      status = text;
      paint();
    },

    askPermission(request) {
      return new Promise((resolve) => {
        pendingAsk = { request, resolve };
        paint();
      });
    },
  };
}
