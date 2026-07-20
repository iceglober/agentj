import type { TodoPort } from "../agent/todos";
import type { ChatLog } from "../session/log";
import { type TodoList, todoListSchema } from "../todos";
import type { ChatEvent } from "./events";

/** Durable, serialized session todo state. */
export interface SessionTodos extends TodoPort {
  readonly items: TodoList;
  clear(): Promise<void>;
}

export const createSessionTodos = (options: {
  log: ChatLog;
  initial?: TodoList;
  onEvent?(event: ChatEvent): void | Promise<void>;
  now?: () => string;
}): SessionTodos => {
  const now = options.now ?? (() => new Date().toISOString());
  let items = todoListSchema.parse(options.initial ?? []);
  let pending = Promise.resolve();

  const replace = async (next: TodoList): Promise<void> => {
    const validated = todoListSchema.parse(next);
    pending = pending.then(async () => {
      await options.log.append({ type: "todos", items: validated, ts: now() });
      items = validated;
      await options.onEvent?.({ type: "todos-updated", items });
    });
    return pending;
  };

  return {
    get items() {
      return items;
    },
    replace,
    clear: () => replace([]),
  };
};
