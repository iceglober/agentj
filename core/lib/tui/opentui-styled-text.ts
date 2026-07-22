import type { StyledText, TextChunk } from "@opentui/core";
import type { UiBlock, UiSpan, UiTextLine } from "./styles";
import { escapeTerminalText } from "./terminal-editor";

/** The subset of the OpenTUI module this mapper needs, so callers pass the
 *  dynamically imported namespace without re-importing it here. */
type OpenTuiModule = Pick<typeof import("@opentui/core"), "RGBA" | "StyledText" | "TextAttributes">;

/** Shared tone/background palette so the transcript, live region, and modals
 *  render the same semantic colors the ANSI adapter emits as SGR codes. */
export const toneColors: Record<NonNullable<UiSpan["tone"]>, string> = {
  accent: "#67d4e8",
  muted: "#8b929c",
  success: "#74d99a",
  warning: "#f2c46d",
  danger: "#f08080",
};
export const backgroundColors: Record<NonNullable<UiSpan["background"]>, string> = {
  muted: "#383f47",
};

export interface OpenTuiStyledText {
  /** Join semantic lines into a single StyledText, one newline between rows. */
  toStyledText(lines: readonly UiTextLine[]): StyledText;
  /** The styled chunks for one span (empty when the span renders no glyphs). */
  chunksForSpan(span: UiSpan): TextChunk[];
}

/**
 * Maps agentj's semantic UI spans to OpenTUI StyledText. Text is escaped and
 * newlines are collapsed to single spaces so a chunk never smuggles control
 * bytes into the renderer; row breaks are added only between whole lines.
 */
export const createOpenTuiStyledText = (
  opentui: OpenTuiModule,
  colorEnabled: boolean,
): OpenTuiStyledText => {
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

  return { toStyledText, chunksForSpan };
};
