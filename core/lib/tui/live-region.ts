/** A vendor-free terminal output boundary for the persistent live region. */
export interface LiveLayout {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export interface LiveRegionPort {
  /** Usable line width, excluding the repaint safety margin. */
  width(): number;
  /** Viewport height when the terminal exposes it. */
  height(): number | null;
  onResize(listener: () => void): () => void;
  setBracketedPaste(enabled: boolean): void;
  paint(layout: LiveLayout): void;
  printAbove(text: string): void;
  clear(): void;
}
