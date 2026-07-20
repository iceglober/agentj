import { expect, test } from "bun:test";
import type { ChatLog, ChatLogRecord } from "../session/log";
import { createSessionTodos } from "./todos";

test("session todos serialize durable updates and emit after persistence", async () => {
  const records: ChatLogRecord[] = [];
  const events: string[] = [];
  const log: ChatLog = {
    id: "test",
    path: "/test",
    append: async (record) => {
      records.push(record);
    },
  };
  const todos = createSessionTodos({
    log,
    now: () => "now",
    onEvent: (event) => {
      if (event.type === "todos-updated") events.push(event.items.map((item) => item.id).join(","));
    },
  });

  await Promise.all([
    todos.replace([{ id: "one", text: "First", status: "pending" }]),
    todos.replace([{ id: "two", text: "Second", status: "completed" }]),
  ]);

  expect(records).toEqual([
    { type: "todos", items: [{ id: "one", text: "First", status: "pending" }], ts: "now" },
    { type: "todos", items: [{ id: "two", text: "Second", status: "completed" }], ts: "now" },
  ]);
  expect(events).toEqual(["one", "two"]);
  expect(todos.items).toEqual([{ id: "two", text: "Second", status: "completed" }]);
});
