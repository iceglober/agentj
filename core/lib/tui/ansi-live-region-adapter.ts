import type { Writable } from "node:stream";
import type { LiveLayout, LiveRegionPort } from "./live-region";
import { createTerminalStyler } from "./styles";
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
  /** Explicit capability override for embedders and deterministic tests. */
  color?: boolean;
}

/**
 * ANSI implementation of the live terminal region. It is the only TUI module
 * that knows cursor-control protocol details; callers render logical layouts.
 *
 * The live region floats directly beneath the transcript rather than being
 * glued to the terminal's bottom: transcript writes use the terminal's own
 * scrolling, and the region is erased and redrawn right where the cursor sits.
 * There is deliberately no scroll bookkeeping — an earlier design tracked a
 * reserved bottom band and manually scrolled to keep it free, which drifted out
 * of sync whenever the region's height changed mid-turn (a tool row appearing,
 * the thinking line toggling) and deposited stray blank rows. With no state to
 * desync, that whole class of spacing bugs cannot occur.
 */
export function createAnsiLiveRegionAdapter(
  options: CreateAnsiLiveRegionAdapterOptions = {},
): LiveRegionPort {
  const stdout = (options.stdout ?? process.stdout) as TerminalOutput;
  const colorEnabled =
    options.color ??
    (stdout.isTTY !== false && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
  const styler = createTerminalStyler({ color: colorEnabled });
  const csi = (sequence: string): string => `[${sequence}`;
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

  /** The layout currently drawn on screen, so it can be erased before a redraw
   *  or a transcript write. Null when the region is not on screen. */
  let lastLayout: LiveLayout | null = null;

  /** Physical rows the cursor sits below the region's first line, wrapping
   *  included — how far up to walk to reach the top of the drawn region. */
  const physicalCursorRow = (layout: LiveLayout): number => {
    const terminalWidth = width();
    const rowsBefore = layout.lines
      .slice(0, layout.cursorRow)
      .reduce(
        (total, line) =>
          total +
          Math.max(
            1,
            Math.ceil(displayWidth(styler.renderLine(line, terminalWidth)) / terminalWidth),
          ),
        0,
      );
    const cursorWrap =
      layout.cursorColumn === 0
        ? 0
        : Math.floor(Math.max(0, layout.cursorColumn - 1) / terminalWidth);
    return rowsBefore + cursorWrap;
  };

  /** Move the cursor to the top-left of the drawn region and clear to the end
   *  of the screen, leaving the cursor where the next line should begin. */
  const eraseRegion = (): void => {
    const cursorRow = lastLayout ? physicalCursorRow(lastLayout) : 0;
    if (cursorRow > 0) write(csi(`${cursorRow}A`));
    write(`\r${csi("J")}`);
  };

  /** Keep the region no taller than the screen so redrawing it can never scroll
   *  the transcript out of reach; the oldest (top) rows drop first. */
  const clamp = (layout: LiveLayout): LiveLayout => {
    const rows = height();
    if (rows === null || layout.lines.length <= rows) return layout;
    const drop = layout.lines.length - rows;
    return {
      lines: layout.lines.slice(drop),
      cursorRow: Math.max(0, layout.cursorRow - drop),
      cursorColumn: layout.cursorColumn,
    };
  };

  return {
    color: () => colorEnabled,
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
      eraseRegion();
      const fitted = clamp(layout);
      write(fitted.lines.map((line) => styler.renderLine(line, contentWidth())).join("\r\n"));
      const up = fitted.lines.length - 1 - fitted.cursorRow;
      write(
        `\r${up > 0 ? csi(`${up}A`) : ""}${fitted.cursorColumn > 0 ? csi(`${fitted.cursorColumn}C`) : ""}`,
      );
      lastLayout = fitted;
    },
    printAbove(text, spacing = "none") {
      // Spacing is semantic: related events are adjacent, while a new user turn
      // gets one leading blank. The live layout supplies the single separator
      // below the transcript when it is painted.
      eraseRegion();
      lastLayout = null;
      const rendered = styler.renderBlock(text).join("\r\n");
      write(`${spacing === "turn" ? "\r\n" : ""}${rendered}\r\n`);
    },
    clear() {
      eraseRegion();
      lastLayout = null;
    },
    clearScreen() {
      write(csi("2J") + csi("H"));
      lastLayout = null;
    },
  };
}
