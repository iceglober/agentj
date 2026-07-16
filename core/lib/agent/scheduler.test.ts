import { describe, expect, test } from "bun:test";
import { scheduleTasks } from "./scheduler";

type Task = { id: string; dependsOn?: string[] };
type Result = { id: string; ok: boolean; state?: "blocked" | "aborted" };

describe("scheduleTasks", () => {
  test("runs ready tasks concurrently, releases dependencies, and returns input order", async () => {
    const starts: string[] = [];
    const results = await scheduleTasks<Task, Result>({
      tasks: [{ id: "1" }, { id: "2" }, { id: "3", dependsOn: ["1", "2"] }],
      concurrency: 2,
      id: (task) => task.id,
      dependencies: (task) => task.dependsOn ?? [],
      async run(task) {
        starts.push(task.id);
        return { id: task.id, ok: true };
      },
      dependencySucceeded: (result) => result.ok,
      blocked: (task) => ({ id: task.id, ok: false, state: "blocked" }),
    });
    expect(starts).toEqual(["1", "2", "3"]);
    expect(results).toEqual([
      { id: "1", ok: true },
      { id: "2", ok: true },
      { id: "3", ok: true },
    ]);
  });

  test("blocks dependents and marks unstarted tasks aborted", async () => {
    const controller = new AbortController();
    const blocked = await scheduleTasks<Task, Result>({
      tasks: [{ id: "1" }, { id: "2", dependsOn: ["1"] }],
      concurrency: 1,
      id: (task) => task.id,
      dependencies: (task) => task.dependsOn ?? [],
      async run(task) {
        return { id: task.id, ok: false };
      },
      dependencySucceeded: (result) => result.ok,
      blocked: (task) => ({ id: task.id, ok: false, state: "blocked" }),
    });
    expect(blocked[1]).toEqual({ id: "2", ok: false, state: "blocked" });

    controller.abort();
    const aborted = await scheduleTasks<Task, Result>({
      tasks: [{ id: "1" }],
      concurrency: 1,
      abortSignal: controller.signal,
      id: (task) => task.id,
      dependencies: () => [],
      run: async (task) => ({ id: task.id, ok: true }),
      dependencySucceeded: (result) => result.ok,
      blocked: (task) => ({ id: task.id, ok: false, state: "blocked" }),
      abortedBeforeStart: (task) => ({ id: task.id, ok: false, state: "aborted" }),
    });
    expect(aborted).toEqual([{ id: "1", ok: false, state: "aborted" }]);
  });
});
