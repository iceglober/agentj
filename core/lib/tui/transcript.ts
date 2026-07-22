import type { UiBlock } from "./styles";

/** Format one user turn as semantic terminal lines. */
export const formatUserTurnBlock = (text: string, transcriptText?: string): UiBlock => {
  if (transcriptText !== undefined)
    return transcriptText.split("\n").map((line) => [{ text: line }]);

  const background = { background: "muted" as const };
  const padding = [{ text: " ", ...background }];
  const lines = text.split("\n").map((line, index) =>
    index === 0
      ? [
          { text: " ", ...background },
          { text: "❯", tone: "accent" as const, bold: true, ...background },
          { text: " ", ...background },
          { text: line, bold: true, ...background },
          { text: " ", ...background },
        ]
      : [{ text: ` ${line} `, bold: true, ...background }],
  );
  return [padding, ...lines, padding];
};
