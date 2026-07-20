import { expect, test } from "bun:test";
import { formatTodoDetails, formatTodoProgressLines } from "./todos";

test("formats a framed progress panel with clear todo markers", () => {
  expect(
    formatTodoProgressLines([
      { id: "one", text: "Inspect the design", status: "completed" },
      { id: "two", text: "Wire the session store", status: "in_progress" },
      { id: "three", text: "Validate", status: "pending" },
    ]),
  ).toEqual([
    "  ╭─ Todos 1/3 done · 1 active",
    "  │ ✓ Inspect the design",
    "  │ → Wire the session store",
    "  ╰─ ○ Validate",
  ]);
});

test("shows every active todo without treating one as current", () => {
  expect(
    formatTodoProgressLines([
      { id: "one", text: "Inspect", status: "completed" },
      { id: "two", text: "Build", status: "in_progress" },
      { id: "three", text: "Test", status: "in_progress" },
      { id: "four", text: "Ship", status: "pending" },
    ]),
  ).toEqual([
    "  ╭─ Todos 1/4 done · 2 active",
    "  │ ✓ Inspect",
    "  │ → Build",
    "  │ → Test",
    "  ╰─ ○ Ship",
  ]);
});

test("collapses fully completed todos and expands when work is added", () => {
  const completed = [
    { id: "one", text: "Inspect", status: "completed" as const },
    { id: "two", text: "Build", status: "completed" as const },
    { id: "three", text: "Test", status: "completed" as const },
  ];
  expect(formatTodoProgressLines(completed)).toEqual(["  Todos 3/3 done"]);
  expect(
    formatTodoProgressLines([...completed, { id: "four", text: "Ship", status: "pending" }]),
  ).toEqual(["  ╭─ Todos 3/4 done", "  │ ✓ Inspect", "  │ ✓ Build", "  │ ✓ Test", "  ╰─ ○ Ship"]);
});

test("preserves todo order and reports hidden active todos", () => {
  const items = [
    { id: "one", text: "Todo 0", status: "pending" as const },
    { id: "two", text: "Todo 1", status: "pending" as const },
    { id: "three", text: "Todo 2", status: "in_progress" as const },
    { id: "four", text: "Todo 3", status: "pending" as const },
  ];
  expect(formatTodoProgressLines(items, 2)).toEqual([
    "  ╭─ Todos 0/4 done · 1 active",
    "  │ ○ Todo 0",
    "  │ ○ Todo 1",
    "  ╰─ … 2 more · 1 active — /todos to view all",
  ]);
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
