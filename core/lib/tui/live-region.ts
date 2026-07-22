import type { Readable } from "node:stream";
import type { UiBlock, UiTextLine } from "./styles";

/** A terminal output boundary for the persistent live region. */
export interface LiveLayout {
  lines: UiTextLine[];
  cursorRow: number;
  cursorColumn: number;
}

export interface LiveRegionPort {
  /** Key input the screen should read instead of the process stdin, when the
   *  adapter owns the terminal. The adapter parses stdin (absorbing terminal
   *  query responses) and forwards raw keystrokes here. Undefined means the
   *  screen reads the process stdin directly. */
  input?: Readable;
  /** Whether semantic UI spans should render SGR styling. */
  color(): boolean;
  /** Usable line width, excluding the repaint safety margin. */
  width(): number;
  /** Viewport height when the terminal exposes it. */
  height(): number | null;
  onResize(listener: () => void): () => void;
  setBracketedPaste(enabled: boolean): void;
  paint(layout: LiveLayout): void;
  printAbove(text: string | UiBlock, spacing?: "none" | "turn"): void;
  /** Release renderer resources; ANSI implementations are no-ops. */
  dispose?(): void;
  clear(): void;
  /** Clear the terminal viewport and forget the floating region. */
  clearScreen(): void;
}
