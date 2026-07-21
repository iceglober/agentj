import type { Writable } from "node:stream";
import type { StyledText, TextChunk } from "@opentui/core";
import type { LiveLayout, LiveRegionPort } from "./live-region";
import type { UiBlock, UiSpan, UiTextLine } from "./styles";
import { escapeTerminalText } from "./terminal-editor";

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
    useKittyKeyboard: null,
    consoleMode: "disabled",
  });
  const footer = new opentui.TextRenderable(renderer, {
    content: "",
    width: Math.max(1, renderer.terminalWidth),
    height: 1,
  });
  renderer.root.add(footer);
  renderer.start();

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
    renderer.removeListener("resize", onRendererResize);
    renderer.destroy();
  };

  return {
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
        Math.max(0, renderer.terminalHeight - renderer.footerHeight + layout.cursorRow),
        true,
      );
      renderer.requestRender();
    },
    printAbove(text, spacing = "none") {
      if (disposed) return;
      const block: UiBlock =
        typeof text === "string" ? text.split("\n").map((line) => [{ text: line }]) : text;
      const renderedBlock: UiBlock = spacing === "turn" ? [[], ...block] : block;
      renderer.writeToScrollback((context) => ({
        root: new opentui.TextRenderable(context.renderContext, {
          content: toStyledText(renderedBlock),
          width: context.width,
          height: Math.max(1, renderedBlock.length),
        }),
        width: context.width,
        height: Math.max(1, renderedBlock.length),
        startOnNewLine: spacing === "turn",
        trailingNewline: true,
      }));
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
