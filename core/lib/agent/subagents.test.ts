import { describe, expect, test } from "bun:test";
import type { ChildSession, ChildSessionFinalizeResult } from "../session";
import {
  createSubagentsTool,
  normalizeSubagentTasks,
  type SubagentProgressEvent,
  type SubagentsResult,
  subagentsInputSchema,
} from "./subagents";

const input = (tasks: unknown[]) => subagentsInputSchema.parse({ tasks });

const run = (text: string) => ({
  text,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

describe("normalizeSubagentTasks", () => {
  test("defaults ids and commit messages; validates references", () => {
    const tasks = normalizeSubagentTasks(
      input([
        { title: "map modules", prompt: "p1" },
        { title: "design", prompt: "p2", waitsOn: ["t1"] },
      ]),
    );
    expect(tasks.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(tasks[1]?.waitsOn).toEqual(["t1"]);
    expect(tasks[0]?.commitMessage).toContain("map modules");
  });

  test.each([
    [[{ title: "a", prompt: "p", waitsOn: ["nope"] }], /unknown task/],
    [[{ id: "x", title: "a", prompt: "p", waitsOn: ["x"] }], /waits on itself/],
    [
      [
        { id: "a", title: "a", prompt: "p", waitsOn: ["b"] },
        { id: "b", title: "b", prompt: "p", waitsOn: ["a"] },
      ],
      /cycle/,
    ],
    [
      [
        { id: "dup", title: "a", prompt: "p" },
        { id: "dup", title: "b", prompt: "p" },
      ],
      /unique/,
    ],
  ])("rejects invalid graphs", (tasks, message) => {
    expect(() => normalizeSubagentTasks(input(tasks))).toThrow(message);
  });
});

describe("research execution", () => {
  test("threads findings through waitsOn, emits progress, blocks dependents of failures", async () => {
    const prompts: Record<string, string> = {};
    const events: SubagentProgressEvent[] = [];
    let tick = 0;
    const tool = createSubagentsTool({
      execution: {
        kind: "research",
        createWorker: async (task) => ({
          generate: async (prompt) => {
            prompts[task.id] = prompt;
            if (task.id === "bad") throw new Error("worker exploded");
            return run(`finding of ${task.id}`);
          },
        }),
      },
      concurrency: 2,
      onProgress: (event) => {
        events.push(event);
      },
      now: () => ++tick,
    });

    const { results, integration } = await (tool.execute({
      tasks: [
        { id: "a", title: "A", prompt: "research a", waitsOn: [] },
        { id: "b", title: "B", prompt: "research b", waitsOn: ["a"] },
        { id: "bad", title: "Bad", prompt: "boom", waitsOn: [] },
        { id: "after-bad", title: "After", prompt: "never runs", waitsOn: ["bad"] },
      ],
    }) as Promise<SubagentsResult>);

    expect(integration).toBeUndefined();
    expect(results.map((result) => [result.id, result.outcome])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["bad", "failed"],
      ["after-bad", "blocked"],
    ]);
    expect(prompts.b).toContain("Prerequisite findings");
    expect(prompts.b).toContain("finding of a");
    expect(events[0]?.type).toBe("dag-started");
    expect(events.at(-1)?.type).toBe("dag-completed");
    expect(events.filter((event) => event.type === "task-blocked")).toHaveLength(1);
  });
});

describe("delegation execution", () => {
  const makeSession = (
    id: string,
    finalized: ChildSessionFinalizeResult,
  ): ChildSession & { finalizeRequests: unknown[] } => {
    const finalizeRequests: unknown[] = [];
    return {
      id,
      path: `/child/${id}`,
      branch: `agent/${id}`,
      base: "base",
      parentRef: "parent-ref",
      async status() {
        return "";
      },
      async diff() {
        return "";
      },
      async log() {
        return "";
      },
      async dispose() {},
      async [Symbol.asyncDispose]() {},
      async finalize(request: unknown) {
        finalizeRequests.push(request);
        return finalized;
      },
      finalizeRequests,
    } as unknown as ChildSession & { finalizeRequests: unknown[] };
  };

  const changed = (id: string): ChildSessionFinalizeResult =>
    ({
      outcome: "changed",
      branch: `agent/${id}`,
      path: `/child/${id}`,
      base: "base",
      commit: `commit-${id}`,
      preserved: false,
      parentRef: "parent-ref",
      head: `commit-${id}`,
      status: "",
      worktreeRemoved: true,
      branchDeleted: false,
    }) as ChildSessionFinalizeResult;

  test("runs children in worktrees from the batch snapshot and integrates results", async () => {
    const integrated: unknown[] = [];
    const sessionRefs: string[] = [];
    const tool = createSubagentsTool({
      execution: {
        kind: "delegation",
        parentRef: "stale-ref",
        createChildSession: async ({ id, parentRef }) => {
          sessionRefs.push(parentRef);
          return makeSession(id, changed(id));
        },
        createChildAgent: async ({ task }) => ({
          generate: async () => run(`built ${task.id}`),
        }),
        prepareBatch: async () => ({
          parentRef: "snapshot-ref",
          integrate: async (results) => {
            integrated.push(results.map((result) => result.outcome));
            return { outcome: "applied", detail: null };
          },
        }),
      },
    });

    const { results, integration } = await (tool.execute({
      tasks: [
        { id: "one", title: "One", prompt: "fix one", waitsOn: [] },
        { id: "two", title: "Two", prompt: "fix two", waitsOn: ["one"] },
      ],
    }) as Promise<SubagentsResult>);

    expect(sessionRefs).toEqual(["snapshot-ref", "snapshot-ref"]);
    expect(results.map((result) => result.outcome)).toEqual(["changed", "changed"]);
    expect(results[0]?.commit).toBe("commit-one");
    expect(integration).toEqual({ outcome: "applied", detail: null });
    expect(integrated).toEqual([[["changed", "changed"]][0]]);
  });

  test("a failing child preserves its branch and blocks dependents", async () => {
    const tool = createSubagentsTool({
      execution: {
        kind: "delegation",
        parentRef: "parent-ref",
        createChildSession: async ({ id }) =>
          makeSession(id, {
            outcome: "preserved",
            reason: "failure",
            branch: `agent/${id}`,
            path: `/child/${id}`,
            base: "base",
            commit: null,
            preserved: true,
            parentRef: "parent-ref",
            head: null,
            status: "",
            worktreeRemoved: false,
            branchDeleted: false,
          } as ChildSessionFinalizeResult),
        createChildAgent: async ({ task }) => ({
          generate: async () => {
            if (task.id === "boom") throw new Error("child failed");
            return run("ok");
          },
        }),
      },
    });

    const { results } = await (tool.execute({
      tasks: [
        { id: "boom", title: "Boom", prompt: "fails", waitsOn: [] },
        { id: "dependent", title: "Dep", prompt: "never", waitsOn: ["boom"] },
      ],
    }) as Promise<SubagentsResult>);

    expect(results[0]).toMatchObject({
      outcome: "failed",
      error: "child failed",
      branch: "agent/boom",
      preserved: true,
    });
    expect(results[1]?.outcome).toBe("blocked");
  });
});
