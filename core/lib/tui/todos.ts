import type { TodoList } from "../todos";
import { truncateWithNotice } from "../truncation";

const marker = {
  pending: "·",
  in_progress: "◐",
  completed: "✓",
} as const;

/** Pure, bounded rows for the persistent section of the chat live region. */
export const formatTodoLines = (items: TodoList, maxRows = 8): string[] => {
  if (items.length === 0) return [];
  const completed = items.filter((item) => item.status === "completed").length;
  const visible = items
    .slice(0, maxRows)
    .map(
      (item) =>
        `  ${marker[item.status]} ${truncateWithNotice(item.text.replace(/\r\n?|\n/gu, " "), 72)}`,
    );
  const hidden = items.length - visible.length;
  return [
    `  todos ${completed}/${items.length}`,
    ...visible,
    ...(hidden > 0 ? [`  … ${hidden} more todos`] : []),
  ];
};
