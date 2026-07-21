import type { UiBlock } from "./styles";

/** Format one user turn as semantic terminal lines. */
export const formatUserTurnBlock = (text: string, transcriptText?: string): UiBlock => {
  if (transcriptText !== undefined)
    return transcriptText.split("\n").map((line) => [{ text: line }]);

  return text.split("\n").map((line, index) => {
    const background = { background: "muted" as const };
    return index === 0
      ? [
          { text: " ", ...background },
          { text: "❯", tone: "accent" as const, bold: true, ...background },
          { text: " ", ...background },
          { text: line, bold: true, ...background },
          { text: " ", ...background },
        ]
      : [{ text: ` ${line} `, bold: true, ...background }];
  });
};
