import type { TodoItem, TodoList } from "../todos";
import { truncateWithNotice } from "../truncation";

const marker = {
  pending: "·",
  in_progress: "◐",
  completed: "✓",
} as const;

/** Maximum todo-item rows reserved in the persistent chat live region. */
export const TODO_LIVE_ROWS = 8;

const completedCount = (items: readonly TodoItem[]): number =>
  items.filter((item) => item.status === "completed").length;

const formatTodoItem = (item: TodoItem, indent = ""): string =>
  `${indent}${marker[item.status]} ${truncateWithNotice(item.text.replace(/\r\n?|\n/gu, " "), 72)}`;

/** Pure, bounded rows for the persistent section of the chat live region. */
export const formatTodoProgressLines = (items: TodoList, maxRows = TODO_LIVE_ROWS): string[] => {
  if (items.length === 0) return [];
  const completed = completedCount(items);
  if (completed === items.length) return [`  Todos ${completed}/${items.length}`];

  const visible = items.slice(0, maxRows).map((item) => formatTodoItem(item, "  "));
  const hidden = items.length - visible.length;
  return [
    `  Todos ${completed}/${items.length}`,
    ...visible,
    ...(hidden > 0 ? [`  … ${hidden} more — /todos to view all`] : []),
  ];
};

/** Full todo list for explicit transcript output such as `/todos`. */
export const formatTodoDetails = (items: TodoList): string => {
  if (items.length === 0) return "No todos this session.";
  return [
    `Todos ${completedCount(items)}/${items.length}`,
    ...items.map((item) => formatTodoItem(item)),
  ].join("\n");
};
