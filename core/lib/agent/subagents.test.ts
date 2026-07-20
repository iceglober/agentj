import { describe, expect, test } from "bun:test";
import type { ChildSession, ChildSessionFinalizeResult } from "../session";
import {
  createRunOneSubagentTool,
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

describe("run one subagent", () => {
  test("wraps one prompt as a single scheduler task", async () => {
    const prompts: string[] = [];
    const tool = createRunOneSubagentTool({
      execution: {
        kind: "research",
        createWorker: async () => ({
          generate: async (prompt) => {
            prompts.push(prompt);
            return run("finding");
          },
        }),
      },
    });

    const result = await tool.execute({ prompt: "Inspect the command router\nThen report risks." });
    expect(prompts).toEqual(["Inspect the command router\nThen report risks."]);
    expect(result).toMatchObject({
      results: [{ id: "t1", title: "Inspect the command router", outcome: "completed" }],
    });
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
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task-completed", id: "a", message: "finding of a" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task-failed", id: "bad", message: "worker exploded" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task-blocked",
        id: "after-bad",
        message: "Blocked by: bad",
      }),
    );
  });
});

describe("task usage events", () => {
  test("cumulative in/out with current context, per task", async () => {
    const events: SubagentProgressEvent[] = [];
    const tool = createSubagentsTool({
      execution: {
        kind: "research",
        createWorker: async () => ({
          generate: async (_prompt, opts) => {
            opts?.onStep?.({
              toolCalls: [],
              toolResults: [],
              usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
            });
            opts?.onStep?.({
              toolCalls: [],
              toolResults: [],
              usage: { inputTokens: 1400, outputTokens: 80, totalTokens: 1480 },
            });
            return run("done");
          },
        }),
      },
      onProgress: (event) => {
        events.push(event);
      },
    });

    await (tool.execute({
      tasks: [{ id: "a", title: "A", prompt: "p", waitsOn: [] }],
    }) as Promise<SubagentsResult>);

    const usage = events.filter((event) => event.type === "task-usage");
    expect(usage).toEqual([
      { type: "task-usage", id: "a", inputTokens: 1000, outputTokens: 50, contextTokens: 1000 },
      { type: "task-usage", id: "a", inputTokens: 2400, outputTokens: 130, contextTokens: 1400 },
    ]);
  });
});

describe("progress event ownership", () => {
  const makeTool = (events: SubagentProgressEvent[], model?: string) =>
    createSubagentsTool({
      execution: {
        kind: "research",
        createWorker: async () => ({ generate: async () => run("done") }),
      },
      ...(model ? { model } : {}),
      onProgress: (event) => {
        events.push(event);
      },
    });

  test("events carry the owning activity id and the child model label", async () => {
    const events: SubagentProgressEvent[] = [];
    const tool = makeTool(events, "azure/gpt-5-mini");
    await (tool.execute(
      { tasks: [{ id: "a", title: "A", prompt: "p", waitsOn: [] }] },
      { activityId: 7 },
    ) as Promise<SubagentsResult>);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.parentActivityId).toBe(7);
    const started = events[0];
    expect(started?.type === "dag-started" && started.tasks[0]?.model).toBe("azure/gpt-5-mini");
  });

  test("events omit ownership and model when neither is configured", async () => {
    const events: SubagentProgressEvent[] = [];
    const tool = makeTool(events);
    await (tool.execute({
      tasks: [{ id: "a", title: "A", prompt: "p", waitsOn: [] }],
    }) as Promise<SubagentsResult>);

    for (const event of events) expect("parentActivityId" in event).toBe(false);
    const started = events[0];
    expect(started?.type === "dag-started" && "model" in (started.tasks[0] ?? {})).toBe(false);
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

  test("a cleanup warning preserves verified child work as changed", async () => {
    const tool = createSubagentsTool({
      execution: {
        kind: "delegation",
        parentRef: "parent-ref",
        createChildSession: async ({ id }) =>
          makeSession(id, {
            ...changed(id),
            worktreeRemoved: false,
            preserved: true,
            warnings: ["git worktree remove --force /child/t1 exited 1: busy"],
          } as ChildSessionFinalizeResult),
        createChildAgent: async () => ({ generate: async () => run("built") }),
      },
    });

    const { results } = await (tool.execute({
      tasks: [{ id: "t1", title: "Task", prompt: "build", waitsOn: [] }],
    }) as Promise<SubagentsResult>);

    expect(results[0]).toMatchObject({
      outcome: "changed",
      preserved: true,
      warnings: ["git worktree remove --force /child/t1 exited 1: busy"],
    });
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
