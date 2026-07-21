import type { TodoItem, TodoList } from "../todos";
import { truncateWithNotice } from "../truncation";

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
  const completed = completedCount(items);
  if (completed === items.length) return [`  ✓ Plan complete · ${completed}/${items.length}`];

  // The live view answers "what is happening next?": active work comes first,
  // then pending work. Completed items remain represented by the header and
  // are still available in full through /todos.
  const remaining = [
    ...items.filter((item) => item.status === "in_progress"),
    ...items.filter((item) => item.status === "pending"),
  ];
  const visible = remaining.slice(0, maxRows).map(formatTodoItem);
  const hiddenCount = remaining.length - visible.length;

  return [
    `  Plan · ${completed}/${items.length} complete`,
    ...visible.map((row) => `    ${row}`),
    ...(hiddenCount > 0 ? [`    +${hiddenCount} more`] : []),
  ];
};

/** Full todo list for explicit transcript output such as `/todos`. */
export const formatTodoDetails = (items: TodoList): string => {
  if (items.length === 0) return "No todos this session.";
  return [formatTodoHeader(items), ...items.map(formatTodoItem)].join("\n");
};
