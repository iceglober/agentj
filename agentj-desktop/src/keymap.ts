// The single source of truth for keyboard shortcuts. The Shortcuts modal
// renders from this list, and App's global keydown handler matches against the
// same `id`s — so the documented keys and the live handlers can't drift.

export type ShortcutId =
  | "send"
  | "newline"
  | "escape"
  | "settings"
  | "newSession"
  | "closeSession"
  | "openRepo"
  | "shortcuts";

export interface Shortcut {
  id: ShortcutId;
  // Rendered chips, in order (glyphs for modifiers).
  keys: string[];
  action: string;
}

export const SHORTCUTS: Shortcut[] = [
  { id: "send", keys: ["Enter"], action: "Send message" },
  { id: "newline", keys: ["⇧", "Enter"], action: "New line" },
  { id: "escape", keys: ["Esc"], action: "Interrupt turn / close a modal" },
  { id: "settings", keys: ["⌘", ","], action: "Open Settings" },
  { id: "newSession", keys: ["⌘", "T"], action: "New worktree session" },
  { id: "closeSession", keys: ["⌘", "W"], action: "Close the current session" },
  { id: "openRepo", keys: ["⌘", "⇧", "O"], action: "Open a repository" },
  { id: "shortcuts", keys: ["⌘", "/"], action: "Keyboard shortcuts" },
];
