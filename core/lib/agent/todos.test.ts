import { expect, test } from "bun:test";
import { createTodoTool } from "./todos";

test("update_todos replaces the full session list", async () => {
  const updates: unknown[] = [];
  const tool = createTodoTool({
    replace: async (items) => {
      updates.push(items);
    },
  });

  await expect(
    tool.execute({
      items: [{ id: "one", text: "Inspect the design", status: "in_progress" }],
    }),
  ).resolves.toBe("Updated session todos (0/1 completed).");
  expect(updates).toEqual([[{ id: "one", text: "Inspect the design", status: "in_progress" }]]);
});
