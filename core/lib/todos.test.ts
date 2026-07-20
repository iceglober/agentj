import { expect, test } from "bun:test";
import { todoListSchema } from "./todos";

test("todo list validates bounded, concise ordered items", () => {
  expect(
    todoListSchema.parse([
      { id: "inspect", text: "Inspect the current design", status: "pending" },
    ]),
  ).toEqual([{ id: "inspect", text: "Inspect the current design", status: "pending" }]);
  expect(
    todoListSchema.safeParse(
      Array.from({ length: 21 }, (_, id) => ({ id: `${id}`, text: "x", status: "pending" })),
    ),
  ).toMatchObject({ success: false });
});
