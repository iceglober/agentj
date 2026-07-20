import type { TodoItem, TodoList } from "../todos";
import { truncateWithNotice } from "../truncation";
import { displayWidth } from "./terminal-editor";

const marker = {
  pending: "○",
  in_progress: "→",
  completed: "✓",
} as const;

/** Maximum todo-item rows reserved in the persistent chat live region. */
export const TODO_LIVE_ROWS = 4;

const completedCount = (items: readonly TodoItem[]): number =>
  items.filter((item) => item.status === "completed").length;

const activeCount = (items: readonly TodoItem[]): number =>
  items.filter((item) => item.status === "in_progress").length;

const formatTodoHeader = (items: readonly TodoItem[]): string => {
  const completed = completedCount(items);
  const active = activeCount(items);
  return `Todos ${completed}/${items.length} done${active > 0 ? ` · ${active} active` : ""}`;
};

const formatTodoItem = (item: TodoItem): string =>
  `${marker[item.status]} ${truncateWithNotice(item.text.replace(/\r\n?|\n/gu, " "), 72)}`;

/** Pure, bounded rows for the persistent section of the chat live region. */
export const formatTodoProgressLines = (items: TodoList, maxRows = TODO_LIVE_ROWS): string[] => {
  if (items.length === 0) return [];
  if (completedCount(items) === items.length) return [`  ${formatTodoHeader(items)}`];

  const visible = items.slice(0, maxRows).map(formatTodoItem);
  const hiddenCount = items.length - visible.length;
  const header = `╭─ ${formatTodoHeader(items)}`;
  const contentRows = visible.map((row) => `│ ${row}`);
  const width = Math.max(displayWidth(header), ...contentRows.map(displayWidth));
  const footer =
    hiddenCount > 0
      ? `╰──── ${hiddenCount} more ${hiddenCount === 1 ? "todo" : "todos"} ...`
      : `╰${"─".repeat(Math.max(0, width - 1))}`;

  return [`  ${header}`, ...contentRows.map((row) => `  ${row}`), `  ${footer}`];
};

/** Full todo list for explicit transcript output such as `/todos`. */
export const formatTodoDetails = (items: TodoList): string => {
  if (items.length === 0) return "No todos this session.";
  return [formatTodoHeader(items), ...items.map(formatTodoItem)].join("\n");
};
