import { z } from "zod";

/** Session-scoped work items shared by the agent, persistence, and TUI. */
export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const todoItemSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(240),
  status: todoStatusSchema,
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/** A bounded full-list update keeps session state simple and atomic. */
export const todoListSchema = z.array(todoItemSchema).max(20);
export type TodoList = z.infer<typeof todoListSchema>;
