import type { Readable, Writable } from "node:stream";
import type { PermissionPromptDecision, PermissionRequest } from "../agent/permissions";
import { applyEditorCommand, createEditorState, type EditorState } from "./editor";
import { TerminalKeyDecoder } from "./key-decoder";
import {
  displayWidth,
  escapeTerminalText,
  renderEditorLayout,
  truncateToDisplayWidth,
  wrapToDisplayWidth,
} from "./terminal-editor";

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
  /** Previously submitted prompts, oldest first. */
  initialHistory?: readonly string[];
}

export interface ChatScreen {
  start(): void;
  stop(): void;
  /** Append transcript output above the live region. */
  /** Append transcript output. Text is sanitized against terminal-escape
   *  injection unless `preStyled` — then the CALLER must have sanitized any
   *  interpolated content before adding its own trusted ANSI styling. */
  printAbove(text: string, options?: { preStyled?: boolean }): void;
  /** Replace the progress block (empty array hides it). */
  setProgressLines(lines: string[]): void;
  setStatus(text: string): void;
  /** Modal single-key permission prompt in the live region. */
  askPermission(request: PermissionRequest): Promise<PermissionPromptDecision>;
}

export function createChatScreen(options: CreateChatScreenOptions): ChatScreen {
  const stdin = (options.stdin ?? process.stdin) as RawInput;
  const stdout = (options.stdout ?? process.stdout) as TerminalOutput;
  const width = (): number =>
    Math.max(
      1,
      Math.floor(
        typeof options.terminalWidth === "function"
          ? options.terminalWidth()
          : (options.terminalWidth ?? stdout.columns ?? 80),
      ),
    );
  const contentWidth = (): number => Math.max(1, width() - 1);

  const decoder = new TerminalKeyDecoder();
  let editor: EditorState = createEditorState();
  const history = (options.initialHistory ?? [])
    .filter((entry) => entry.trim().length > 0)
    .slice(-100);
  let historyIndex: number | null = null;
  let progressLines: string[] = [];
  let status = "";
  let started = false;
  let previousRawMode = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;
  let quitArmedAt = 0;
  interface PendingAsk {
    request: PermissionRequest;
    resolve: (decision: PermissionPromptDecision) => void;
  }
  let pendingAsk: PendingAsk | null = null;
  const askQueue: PendingAsk[] = [];

  const write = (text: string): void => {
    stdout.write(text);
  };

  interface LiveLayout {
    lines: string[];
    cursorRow: number;
    cursorColumn: number;
  }

  const safeLine = (line: string): string =>
    truncateToDisplayWidth(escapeTerminalText(line).replace(/\n+/gu, " "), contentWidth());

  const liveLines = (): LiveLayout => {
    const progress = progressLines.map(safeLine);
    const safeStatus = safeLine(status);
    if (pendingAsk) {
      const askLines = [
        ...wrapToDisplayWidth(
          `Permission ${escapeTerminalText(pendingAsk.request.tool)} — review request above`,
          contentWidth(),
        ),
        ...wrapToDisplayWidth("[y]es once · [a]lways this session · [n]o", contentWidth()),
      ];
      const askCursorRow = progress.length + askLines.length - 1;
      return {
        lines: [...progress, ...askLines, safeStatus],
        cursorRow: askCursorRow,
        cursorColumn: displayWidth(askLines.at(-1) ?? ""),
      };
    }
    const layout = renderEditorLayout(editor, contentWidth());
    return {
      lines: [...progress, ...layout.rows, safeStatus],
      cursorRow: progress.length + layout.cursorRow,
      cursorColumn: layout.cursorColumn,
    };
  };

  const csi = (sequence: string): string => `\u001b[${sequence}`;

  /** The previous logical layout is retained so a resize can account for
   * terminal reflow before climbing back to the live region's first row. */
  let lastLayout: LiveLayout | null = null;

  const physicalCursorRow = (layout: LiveLayout): number => {
    const terminalWidth = width();
    const rowsBefore = layout.lines
      .slice(0, layout.cursorRow)
      .reduce(
        (total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / terminalWidth)),
        0,
      );
    const cursorWrap =
      layout.cursorColumn === 0
        ? 0
        : Math.floor(Math.max(0, layout.cursorColumn - 1) / terminalWidth);
    return rowsBefore + cursorWrap;
  };

  const moveToRegionTop = (): void => {
    const cursorRow = lastLayout ? physicalCursorRow(lastLayout) : 0;
    if (cursorRow > 0) write(csi(`${cursorRow}A`));
    write(`\r${csi("J")}`);
  };

  const paint = (): void => {
    const layout = liveLines();
    moveToRegionTop();
    write(layout.lines.join("\r\n"));
    const up = layout.lines.length - 1 - layout.cursorRow;
    write(
      `\r${up > 0 ? csi(`${up}A`) : ""}${layout.cursorColumn > 0 ? csi(`${layout.cursorColumn}C`) : ""}`,
    );
    lastLayout = layout;
  };

  const clearLive = (): void => {
    if (lastLayout) moveToRegionTop();
    lastLayout = null;
  };

  const printTranscript = (text: string, preStyled = false): void => {
    clearLive();
    write(`${(preStyled ? text : escapeTerminalText(text)).split("\n").join("\r\n")}\r\n`);
    paint();
  };

  const printPermissionRequest = (request: PermissionRequest): void => {
    printTranscript(`Permission ${request.tool}:\n${request.detail}`);
  };

  const armEscapeFlush = (): void => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      if (decoder.flush().length > 0) options.callbacks.onEscape();
    }, options.escapeFlushMs ?? 40);
  };

  const settleAsk = (decision: PermissionPromptDecision): void => {
    const ask = pendingAsk;
    if (!ask) return;
    pendingAsk = askQueue.shift() ?? null;
    ask.resolve(decision);
    if (pendingAsk) printPermissionRequest(pendingAsk.request);
    else paint();
  };

  const handleAskKey = (command: { type: string; text?: string }): void => {
    if (!pendingAsk) return;
    const key = command.type === "insert" ? command.text?.toLowerCase() : null;
    const decision =
      key === "y"
        ? "allow"
        : key === "a"
          ? "always"
          : key === "n" || command.type === "cancel" || command.type === "escape"
            ? "deny"
            : null;
    if (decision) settleAsk(decision);
  };

  const browseHistory = (direction: -1 | 1): boolean => {
    if (history.length === 0) return false;
    if (historyIndex === null) {
      if (direction === 1 || editor.text.length > 0) return false;
      historyIndex = history.length - 1;
    } else {
      const next = historyIndex + direction;
      if (next >= history.length) {
        historyIndex = null;
        editor = createEditorState();
        paint();
        return true;
      }
      historyIndex = Math.max(0, next);
    }
    editor = createEditorState(history[historyIndex] ?? "");
    paint();
    return true;
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
        if (history.at(-1) !== text) history.push(text);
        if (history.length > 100) history.shift();
        historyIndex = null;
        editor = createEditorState();
        paint();
        options.callbacks.onSubmit(text);
        return;
      }
      case "cancel": {
        if (editor.text.length > 0) {
          historyIndex = null;
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
        if (command.type === "move-up" && browseHistory(-1)) return;
        if (command.type === "move-down" && historyIndex !== null && browseHistory(1)) return;
        historyIndex = null;
        editor = applyEditorCommand(editor, command);
        paint();
    }
  };

  const onResize = (): void => {
    if (started) paint();
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
      stdout.on("resize", onResize);
      if (stdin.setRawMode && !previousRawMode) stdin.setRawMode(true);
      stdin.resume?.();
      paint();
    },

    stop() {
      if (!started) return;
      started = false;
      if (escapeTimer) clearTimeout(escapeTimer);
      stdin.removeListener("data", onData);
      stdout.removeListener("resize", onResize);
      if (stdin.setRawMode) stdin.setRawMode(previousRawMode);
      clearLive();
      const asks = pendingAsk ? [pendingAsk, ...askQueue] : [...askQueue];
      pendingAsk = null;
      askQueue.length = 0;
      for (const ask of asks) ask.resolve("deny");
      write("\r\n");
    },

    printAbove(text, options) {
      printTranscript(text, options?.preStyled === true);
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
      if (!started) return Promise.resolve("deny");
      return new Promise((resolve) => {
        const ask = { request, resolve };
        if (pendingAsk) askQueue.push(ask);
        else {
          pendingAsk = ask;
          printPermissionRequest(request);
        }
      });
    },
  };
}
