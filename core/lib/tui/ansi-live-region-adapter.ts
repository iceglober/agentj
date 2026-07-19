import type { Writable } from "node:stream";
import type { LiveLayout, LiveRegionPort } from "./live-region";
import { displayWidth } from "./terminal-editor";

interface TerminalOutput extends Writable {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}

export interface CreateAnsiLiveRegionAdapterOptions {
  stdout?: Writable;
  terminalWidth?: number | (() => number);
  terminalHeight?: number | (() => number);
}

/**
 * ANSI implementation of the live terminal region. It is the only TUI module
 * that knows cursor-control protocol details; callers render logical layouts.
 */
export function createAnsiLiveRegionAdapter(
  options: CreateAnsiLiveRegionAdapterOptions = {},
): LiveRegionPort {
  const stdout = (options.stdout ?? process.stdout) as TerminalOutput;
  const csi = (sequence: string): string => `\u001b[${sequence}`;
  const write = (text: string): void => {
    stdout.write(text);
  };
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
  const height = (): number | null => {
    const rows =
      typeof options.terminalHeight === "function"
        ? options.terminalHeight()
        : (options.terminalHeight ?? stdout.rows);
    return typeof rows === "number" && Number.isFinite(rows) ? Math.max(3, Math.floor(rows)) : null;
  };

  let lastLayout: LiveLayout | null = null;
  let reservedRows = 0;
  let knownHeight: number | null = null;

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

  const moveToRelativeRegionTop = (): void => {
    const cursorRow = lastLayout ? physicalCursorRow(lastLayout) : 0;
    if (cursorRow > 0) write(csi(`${cursorRow}A`));
    write(`\r${csi("J")}`);
  };

  const resetForResize = (rows: number): void => {
    if (knownHeight === null || knownHeight === rows) return;
    if (reservedRows > 0) {
      write(`${csi(`${Math.max(1, rows - reservedRows + 1)};1H`)}${csi("J")}`);
    }
    reservedRows = 0;
  };

  const reserve = (rows: number, terminalHeight: number): void => {
    if (rows <= reservedRows) return;
    if (reservedRows > 0) {
      write(`${csi(`${Math.max(1, terminalHeight - reservedRows + 1)};1H`)}${csi("J")}`);
    }
    const additional = rows - reservedRows;
    write(csi(`${terminalHeight};1H`));
    write("\n".repeat(additional));
    reservedRows = rows;
  };

  const clamp = (layout: LiveLayout, terminalHeight: number): LiveLayout => {
    if (layout.lines.length <= terminalHeight) return layout;
    const drop = layout.lines.length - terminalHeight;
    const cursorRow = layout.cursorRow - drop;
    return {
      lines: layout.lines.slice(drop),
      cursorRow: Math.max(0, cursorRow),
      cursorColumn: cursorRow < 0 ? 0 : layout.cursorColumn,
    };
  };

  const paintAnchored = (layout: LiveLayout, terminalHeight: number): void => {
    resetForResize(terminalHeight);
    const fitted = clamp(layout, terminalHeight);
    reserve(fitted.lines.length, terminalHeight);
    const start = terminalHeight - fitted.lines.length + 1;
    write(`${csi(`${Math.max(1, terminalHeight - reservedRows + 1)};1H`)}${csi("J")}`);
    write(`${csi(`${start};1H`)}${fitted.lines.join("\r\n")}`);
    write(csi(`${start + fitted.cursorRow};${fitted.cursorColumn + 1}H`));
    lastLayout = fitted;
    knownHeight = terminalHeight;
  };

  const paintRelative = (layout: LiveLayout): void => {
    moveToRelativeRegionTop();
    write(layout.lines.join("\r\n"));
    const up = layout.lines.length - 1 - layout.cursorRow;
    write(
      `\r${up > 0 ? csi(`${up}A`) : ""}${layout.cursorColumn > 0 ? csi(`${layout.cursorColumn}C`) : ""}`,
    );
    lastLayout = layout;
  };

  return {
    color: () =>
      stdout.isTTY !== false && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
    width: contentWidth,
    height,
    onResize(listener) {
      stdout.on("resize", listener);
      return () => stdout.removeListener("resize", listener);
    },
    setBracketedPaste(enabled) {
      write(csi(`?2004${enabled ? "h" : "l"}`));
    },
    paint(layout) {
      const rows = height();
      if (rows === null) paintRelative(layout);
      else paintAnchored(layout, rows);
    },
    printAbove(text) {
      const rows = height();
      if (rows === null) {
        moveToRelativeRegionTop();
        lastLayout = null;
        write(`${text}\r\n\r\n`);
        return;
      }
      resetForResize(rows);
      if (reservedRows === 0) reserve(1, rows);
      write(`${csi(`${Math.max(1, rows - reservedRows + 1)};1H`)}${csi("J")}`);
      // One transcript separator plus the reserved blank rows moves all text
      // above the live region while using normal full-screen scrolling.
      write(
        `${csi(`${Math.max(1, rows - reservedRows + 1)};1H`)}${text}\r\n${"\r\n".repeat(reservedRows)}`,
      );
      lastLayout = null;
      knownHeight = rows;
    },
    clear() {
      const rows = height();
      if (rows === null) {
        if (lastLayout) moveToRelativeRegionTop();
      } else if (reservedRows > 0) {
        resetForResize(rows);
        write(`${csi(`${Math.max(1, rows - reservedRows + 1)};1H`)}${csi("J")}`);
      }
      lastLayout = null;
    },
  };
}
