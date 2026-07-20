import type { UiBlock } from "./styles";

/** Format one user turn as semantic terminal lines. */
export const formatUserTurnBlock = (text: string, transcriptText?: string): UiBlock => {
  if (transcriptText !== undefined)
    return transcriptText.split("\n").map((line) => [{ text: line }]);

  return text
    .split("\n")
    .map((line, index) =>
      index === 0
        ? [{ text: "❯", tone: "accent", bold: true }, { text: " " }, { text: line, bold: true }]
        : [{ text: line, bold: true }],
    );
};
