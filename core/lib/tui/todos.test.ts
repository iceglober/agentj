import { expect, test } from "bun:test";
import { formatTodoDetails, formatTodoProgressLines } from "./todos";

test("keeps the live plan compact and focused on remaining work", () => {
  expect(
    formatTodoProgressLines([
      { id: "one", text: "Inspect the design", status: "completed" },
      { id: "two", text: "Wire the session store", status: "in_progress" },
      { id: "three", text: "Validate", status: "pending" },
    ]),
  ).toEqual(["  Todos · 1/3 complete", "    → Wire the session store", "    ○ Validate"]);
});

test("shows every active todo without treating one as current", () => {
  expect(
    formatTodoProgressLines([
      { id: "one", text: "Inspect", status: "completed" },
      { id: "two", text: "Build", status: "in_progress" },
      { id: "three", text: "Test", status: "in_progress" },
      { id: "four", text: "Ship", status: "pending" },
    ]),
  ).toEqual(["  Todos · 1/4 complete", "    → Build", "    → Test", "    ○ Ship"]);
});

test("collapses fully completed todos and expands when work is added", () => {
  const completed = [
    { id: "one", text: "Inspect", status: "completed" as const },
    { id: "two", text: "Build", status: "completed" as const },
    { id: "three", text: "Test", status: "completed" as const },
  ];
  expect(formatTodoProgressLines(completed)).toEqual(["  ✓ Todos complete · 3/3"]);
  expect(
    formatTodoProgressLines([...completed, { id: "four", text: "Ship", status: "pending" }]),
  ).toEqual(["  Todos · 3/4 complete", "    ○ Ship"]);
});

test("prioritizes active work before pending work and reports overflow", () => {
  const items = [
    { id: "one", text: "Todo 0", status: "pending" as const },
    { id: "two", text: "Todo 1", status: "pending" as const },
    { id: "three", text: "Todo 2", status: "in_progress" as const },
    { id: "four", text: "Todo 3", status: "pending" as const },
  ];
  expect(formatTodoProgressLines(items, 2)).toEqual([
    "  Todos · 0/4 complete",
    "    → Todo 2",
    "    ○ Todo 0",
    "    +2 more",
  ]);
});

test("caps the live plan at four items and shows compact overflow", () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `todo-${index}`,
    text: `Todo ${index}`,
    status: index === 0 ? ("in_progress" as const) : ("pending" as const),
  }));
  const lines = formatTodoProgressLines(items);
  expect(lines).toHaveLength(6);
  expect(lines.slice(1, 5).every((line) => line.startsWith("    "))).toBe(true);
  expect(lines[5]).toBe("    +2 more");
});

test("formats every todo for explicit transcript output", () => {
  expect(
    formatTodoDetails([
      { id: "one", text: "Inspect", status: "completed" },
      { id: "two", text: "Build", status: "in_progress" },
      { id: "three", text: "Ship", status: "pending" },
    ]),
  ).toBe("Todos 1/3 done · 1 active\n✓ Inspect\n→ Build\n○ Ship");
  expect(formatTodoDetails([])).toBe("No todos this session.");
});
