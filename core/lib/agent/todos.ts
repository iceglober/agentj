import { z } from "zod";
import { defineTool } from "../llm";
import { type TodoList, todoListSchema } from "../todos";

/** A narrow session capability; agents never depend on chat or TUI code. */
export interface TodoPort {
  /** Current durable work state, used by completion grounding. */
  list(): TodoList;
  replace(items: TodoList): Promise<void>;
}

const inputSchema = z.object({
  items: todoListSchema,
});

/** Replace the session's ordered todo list in one durable update. */
export const createTodoTool = (port: TodoPort) =>
  defineTool({
    description: [
      "Maintain the session todo list for work that has more than one meaningful step.",
      "Call this early with concise, ordered items; update it as work progresses; mark items",
      "completed when done. Replace the entire list on each call. The user sees the list live",
      "in the terminal, and it persists when this chat session is resumed. Do not use it for",
      "a single trivial task. Clear it with an empty items array once it no longer helps.",
    ].join("\n"),
    inputSchema,
    execute: async ({ items }) => {
      await port.replace(items);
      const completed = items.filter((item) => item.status === "completed").length;
      return `Updated session todos (${completed}/${items.length} completed).`;
    },
  });
