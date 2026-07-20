/** A vendor-free terminal output boundary for the persistent live region. */
export interface LiveLayout {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export interface LiveRegionPort {
  /** Whether semantic UI spans should render SGR styling. */
  color(): boolean;
  /** Usable line width, excluding the repaint safety margin. */
  width(): number;
  /** Viewport height when the terminal exposes it. */
  height(): number | null;
  onResize(listener: () => void): () => void;
  setBracketedPaste(enabled: boolean): void;
  paint(layout: LiveLayout): void;
  printAbove(text: string, spacing?: "none" | "turn"): void;
  clear(): void;
  /** Clear the terminal viewport and forget the floating region. */
  clearScreen(): void;
}
