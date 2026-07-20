import { expect, test } from "bun:test";
import { formatTodoLines } from "./todos";

test("formats a bounded persistent todo block", () => {
  expect(
    formatTodoLines([
      { id: "one", text: "Inspect the design", status: "completed" },
      { id: "two", text: "Wire the session store", status: "in_progress" },
      { id: "three", text: "Validate", status: "pending" },
    ]),
  ).toEqual([
    "  todos 1/3",
    "  ✓ Inspect the design",
    "  ◐ Wire the session store",
    "  · Validate",
  ]);
});

test("notes hidden todo rows", () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `${index}`,
    text: `Todo ${index}`,
    status: "pending" as const,
  }));
  expect(formatTodoLines(items, 2)).toEqual([
    "  todos 0/3",
    "  · Todo 0",
    "  · Todo 1",
    "  … 1 more todos",
  ]);
});
