// Parse the session's `todos` markdown artifact into a flat checklist.
// The agent owns this file; we only read it. Recognized lines:
//   - [x] …            → done   (X is case-insensitive)
//   - [ ] …            → todo
//   - [~] / [/] / [-]  → doing  (in-progress markers)
// Any non-checkbox line is ignored. Order is preserved.

export type TodoState = "done" | "doing" | "todo";

export interface TodoItem {
  text: string;
  state: TodoState;
}

// - [ ] text  ·  optional leading whitespace, "-", "*" or "+" bullets.
const LINE = /^\s*[-*+]\s+\[(.)\]\s+(.*\S)?\s*$/;

export function parseTodos(md: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const text = (m[2] ?? "").trim();
    if (!text) continue;
    let state: TodoState;
    if (mark === "x") state = "done";
    else if (mark === " ") state = "todo";
    else if (mark === "~" || mark === "/" || mark === "-") state = "doing";
    else continue; // unknown marker — not a todo we render
    items.push({ text, state });
  }
  return items;
}
