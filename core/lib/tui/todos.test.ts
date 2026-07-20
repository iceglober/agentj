import { expect, test } from "bun:test";
import { formatTodoDetails, formatTodoProgressLines } from "./todos";

test("formats incomplete todos in the persistent progress block", () => {
  expect(
    formatTodoProgressLines([
      { id: "one", text: "Inspect the design", status: "completed" },
      { id: "two", text: "Wire the session store", status: "in_progress" },
      { id: "three", text: "Validate", status: "pending" },
    ]),
  ).toEqual([
    "  Todos 1/3",
    "  ✓ Inspect the design",
    "  ◐ Wire the session store",
    "  · Validate",
  ]);
});

test("collapses fully completed todos and expands when work is added", () => {
  const completed = [
    { id: "one", text: "Inspect", status: "completed" as const },
    { id: "two", text: "Build", status: "completed" as const },
    { id: "three", text: "Test", status: "completed" as const },
  ];
  expect(formatTodoProgressLines(completed)).toEqual(["  Todos 3/3"]);
  expect(
    formatTodoProgressLines([...completed, { id: "four", text: "Ship", status: "pending" }]),
  ).toEqual(["  Todos 3/4", "  ✓ Inspect", "  ✓ Build", "  ✓ Test", "  · Ship"]);
});

test("directs overflow to the full todo command", () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `${index}`,
    text: `Todo ${index}`,
    status: "pending" as const,
  }));
  expect(formatTodoProgressLines(items, 2)).toEqual([
    "  Todos 0/3",
    "  · Todo 0",
    "  · Todo 1",
    "  … 1 more — /todos to view all",
  ]);
});

test("formats every todo for explicit transcript output", () => {
  expect(
    formatTodoDetails([
      { id: "one", text: "Inspect", status: "completed" },
      { id: "two", text: "Build", status: "in_progress" },
    ]),
  ).toBe("Todos 1/2\n✓ Inspect\n◐ Build");
  expect(formatTodoDetails([])).toBe("No todos this session.");
});
