import { PassThrough, type Writable } from "node:stream";
import type { StyledText, TextChunk } from "@opentui/core";
import type { LiveLayout, LiveRegionPort } from "./live-region";
import type { UiBlock, UiSpan, UiTextLine } from "./styles";
import { displayWidth, escapeTerminalText } from "./terminal-editor";

interface TerminalOutput extends Writable {
  columns?: number;
  rows?: number;
}

export interface CreateOpenTuiLiveRegionAdapterOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: Writable;
  terminalWidth?: number;
  terminalHeight?: number;
  color?: boolean;
}

const toneColors: Record<NonNullable<UiSpan["tone"]>, string> = {
  accent: "#67d4e8",
  muted: "#8b929c",
  success: "#74d99a",
  warning: "#f2c46d",
  danger: "#f08080",
};
const backgroundColors: Record<NonNullable<UiSpan["background"]>, string> = {
  muted: "#30363d",
};

/**
 * OpenTUI-backed live region used by the opt-in framework spike. It deliberately
 * keeps ChatScreen as the input/state owner while OpenTUI owns the split footer,
 * scrollback commits, cursor, and terminal cleanup.
 */
export async function createOpenTuiLiveRegionAdapter(
  options: CreateOpenTuiLiveRegionAdapterOptions = {},
): Promise<LiveRegionPort> {
  const opentui: typeof import("@opentui/core") = await import("@opentui/core");
  const stdout = (options.stdout ?? process.stdout) as TerminalOutput;
  const colorEnabled = options.color ?? true;
  const renderer = await opentui.createCliRenderer({
    stdin: options.stdin ?? process.stdin,
    stdout: stdout as NodeJS.WriteStream,
    width: options.terminalWidth,
    height: options.terminalHeight,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 1,
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: false,
    useMouse: false,
    autoFocus: false,
    // ChatScreen owns input and decodes raw stdin bytes. OpenTUI enables the
    // kitty keyboard protocol by default (null resolves to flags 5), which
    // re-encodes Ctrl+C as a CSI-u event the decoder doesn't recognize. Zeroing
    // the flags keeps the terminal in legacy mode so Ctrl+C stays "\x03".
    useKittyKeyboard: { disambiguate: false, alternateKeys: false },
    consoleMode: "disabled",
  });
  const footer = new opentui.TextRenderable(renderer, {
    content: "",
    width: Math.max(1, renderer.terminalWidth),
    height: 1,
  });
  renderer.root.add(footer);
  renderer.start();

  // The split footer floats inline at the real cursor row (`renderOffset`), not
  // pinned to the terminal bottom, so the editor cursor must be measured from
  // there — `terminalHeight - footerHeight` lands it ~a screenful too low.
  // renderOffset is private; fall back to the pinned bottom offset if a future
  // OpenTUI release drops it.
  const footerTopRow = (): number => {
    const offset = (renderer as unknown as { renderOffset?: number }).renderOffset;
    return typeof offset === "number" && Number.isFinite(offset)
      ? Math.max(0, offset)
      : Math.max(0, renderer.terminalHeight - renderer.footerHeight);
  };

  const width = (): number =>
    Math.max(1, Math.floor(options.terminalWidth ?? renderer.terminalWidth) - 1);
  const height = (): number =>
    Math.max(3, Math.floor(options.terminalHeight ?? renderer.terminalHeight));
  const resizeListeners = new Set<() => void>();
  const onRendererResize = (): void => {
    for (const listener of resizeListeners) listener();
  };
  renderer.on("resize", onRendererResize);
  let disposed = false;

  // OpenTUI owns the raw stdin and parses it, absorbing terminal query
  // responses (cursor reports, capability probes) that would otherwise corrupt
  // the screen's key decoder. Real keystrokes are re-emitted as raw bytes on
  // this stream, which the screen reads in place of the process stdin.
  const input = new PassThrough();
  const onKeypress = (event: { raw?: string; sequence?: string }): void => {
    if (disposed) return;
    const bytes = event.raw ?? event.sequence ?? "";
    if (bytes.length > 0) input.write(Buffer.from(bytes, "utf8"));
  };
  const onPaste = (event: { bytes: Uint8Array }): void => {
    if (disposed) return;
    // Rewrap in bracketed-paste markers so the screen's decoder treats the
    // payload as one paste, matching what it reads straight from a terminal.
    const text = Buffer.from(event.bytes).toString("utf8");
    input.write(Buffer.from(`[200~${text}[201~`, "utf8"));
  };
  renderer.keyInput.on("keypress", onKeypress);
  renderer.keyInput.on("paste", onPaste);

  const attributes = (span: UiSpan): number =>
    (span.bold ? opentui.TextAttributes.BOLD : 0) |
    (span.italic ? opentui.TextAttributes.ITALIC : 0) |
    (span.underline ? opentui.TextAttributes.UNDERLINE : 0);

  const chunksForSpan = (span: UiSpan): TextChunk[] => {
    const text = escapeTerminalText(span.text).replace(/\n+/gu, " ");
    if (text.length === 0) return [];
    return [
      {
        __isChunk: true,
        text,
        ...(colorEnabled && span.tone ? { fg: opentui.RGBA.fromHex(toneColors[span.tone]) } : {}),
        ...(colorEnabled && span.background
          ? { bg: opentui.RGBA.fromHex(backgroundColors[span.background]) }
          : {}),
        attributes: colorEnabled ? attributes(span) : 0,
      },
    ];
  };

  /** Escaped display width of a single semantic line, matching the chunk text. */
  const lineWidth = (line: UiTextLine): number => {
    const spans: UiBlock[number] = typeof line === "string" ? [{ text: line }] : line;
    return spans.reduce(
      (total, span) => total + displayWidth(escapeTerminalText(span.text).replace(/\n+/gu, " ")),
      0,
    );
  };

  /** Rows a wrapped block occupies at a given width, so scrollback commits reserve
   *  enough height for word-wrapped lines instead of clipping to one row each. */
  const wrappedRows = (lines: readonly UiTextLine[], columns: number): number =>
    lines.reduce(
      (total, line) => total + Math.max(1, Math.ceil(lineWidth(line) / Math.max(1, columns))),
      0,
    );

  const toStyledText = (lines: readonly UiTextLine[]): StyledText => {
    const chunks: TextChunk[] = [];
    lines.forEach((line, index) => {
      if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
      const spans: UiBlock[number] = typeof line === "string" ? [{ text: line }] : line;
      for (const span of spans) chunks.push(...chunksForSpan(span));
    });
    return new opentui.StyledText(chunks);
  };

  const semanticFooter = (lines: readonly UiTextLine[]): void => {
    footer.content = toStyledText(lines);
    footer.width = Math.max(1, renderer.terminalWidth);
    footer.height = Math.max(1, lines.length);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    renderer.keyInput.removeListener("keypress", onKeypress);
    renderer.keyInput.removeListener("paste", onPaste);
    input.end();
    renderer.removeListener("resize", onRendererResize);
    renderer.destroy();
  };

  return {
    input,
    color: () => colorEnabled,
    width,
    height,
    onResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    setBracketedPaste(enabled) {
      stdout.write(`\u001b[?2004${enabled ? "h" : "l"}`);
    },
    paint(layout: LiveLayout) {
      if (disposed) return;
      renderer.footerHeight = Math.max(1, layout.lines.length);
      semanticFooter(layout.lines);
      renderer.setCursorPosition(
        Math.max(0, layout.cursorColumn),
        footerTopRow() + Math.max(0, layout.cursorRow),
        true,
      );
      renderer.requestRender();
    },
    printAbove(text, spacing = "none") {
      if (disposed) return;
      const block: UiBlock =
        typeof text === "string" ? text.split("\n").map((line) => [{ text: line }]) : text;
      const renderedBlock: UiBlock = spacing === "turn" ? [[], ...block] : block;
      renderer.writeToScrollback((context) => {
        // Reserve enough rows for word-wrapped lines; a fixed one-row-per-line
        // height would clip a long paragraph to its first visual row.
        const height = Math.max(1, wrappedRows(renderedBlock, context.width));
        return {
          root: new opentui.TextRenderable(context.renderContext, {
            content: toStyledText(renderedBlock),
            width: context.width,
            height,
            wrapMode: "word",
          }),
          width: context.width,
          height,
          startOnNewLine: spacing === "turn",
          trailingNewline: true,
        };
      });
    },
    clear() {
      if (disposed) return;
      footer.content = "";
      renderer.requestRender();
    },
    clearScreen() {
      if (disposed) return;
      renderer.resetSplitFooterForReplay({ clearSavedLines: true });
      footer.content = "";
      renderer.requestRender();
    },
    dispose,
  };
}
