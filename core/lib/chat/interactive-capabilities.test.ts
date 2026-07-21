import { describe, expect, test } from "bun:test";
import { createInteractiveCapabilityBinder } from "./interactive-capabilities";
import type { JobRunner } from "./jobs";

describe("createInteractiveCapabilityBinder", () => {
  test("exposes safe unavailable behavior before interactive capabilities attach", async () => {
    const binder = createInteractiveCapabilityBinder();

    expect(binder.jobs.start("build", "work")).toEqual({
      error: "Background jobs are unavailable in this session.",
    });
    expect(binder.jobs.inspect("j1")).toBeUndefined();
    expect(binder.jobs.renewSoftTimeout("j1", 1_000)).toBe(false);
    expect(binder.jobs.abort("j1")).toBe(false);
    expect(binder.todos.list()).toEqual([]);
    await expect(binder.todos.replace([])).rejects.toThrow("Session todos are unavailable");
    await expect(binder.questions.ask([] as never)).rejects.toThrow(
      "User questions are unavailable",
    );
  });

  test("keeps stable ports and delegates to the attached interactive runtime", async () => {
    const binder = createInteractiveCapabilityBinder();
    const started: string[] = [];
    const todoUpdates: unknown[] = [];
    binder.attach({
      jobs: {
        start: (_mode, prompt) => {
          started.push(prompt);
          return { id: "j1" } as ReturnType<JobRunner["start"]>;
        },
        inspect: () => undefined,
        renewSoftTimeout: () => true,
        abort: () => true,
      },
      todos: {
        list: () => [{ id: "t1", text: "work", status: "in_progress" }],
        replace: async (items) => {
          todoUpdates.push(items);
        },
      },
      questions: {
        ask: async () => [{ header: "Choice", question: "Pick", answers: ["A"] }],
      },
    });

    expect(binder.jobs.start("build", "work")).toEqual({ id: "j1" });
    expect(started).toEqual(["work"]);
    expect(binder.jobs.renewSoftTimeout("j1", 1_000)).toBe(true);
    expect(binder.jobs.abort("j1")).toBe(true);
    expect(binder.todos.list()).toEqual([{ id: "t1", text: "work", status: "in_progress" }]);
    await binder.todos.replace([]);
    expect(todoUpdates).toEqual([[]]);
    expect(await binder.questions.ask([] as never)).toEqual([
      { header: "Choice", question: "Pick", answers: ["A"] },
    ]);
  });
});
