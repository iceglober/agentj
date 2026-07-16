import { describe, expect, test } from "bun:test";
import type { RunResult } from "../llm";
import {
  createPlanningDagTool,
  type PlanningDagProgressEvent,
  planningDagInputSchema,
} from "./planning-delegate";

const runResult = (text: string): RunResult => ({
  text,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

describe("createPlanningDagTool", () => {
  test("serializes tasks within numeric lanes and releases dependent lanes", async () => {
    const starts: string[] = [];
    const prompts = new Map<string, string>();
    const progress: PlanningDagProgressEvent[] = [];
    let clock = 0;
    const tool = createPlanningDagTool({
      concurrency: 3,
      now: () => ++clock,
      onProgress: (event) => {
        progress.push(event);
      },
      async createWorker(task) {
        return {
          async generate(prompt) {
            starts.push(task.id);
            prompts.set(task.id, prompt);
            return runResult(`finding ${task.id}`);
          },
        };
      },
    });
    const output = await tool.execute(
      planningDagInputSchema.parse({
        lanes: [
          {
            title: "Repository research",
            tasks: [
              { title: "Map modules", prompt: "inspect modules" },
              { title: "Inspect metrics", prompt: "inspect metrics" },
            ],
          },
          {
            title: "Command design",
            waitsOn: [1],
            tasks: [{ title: "Design command", prompt: "design" }],
          },
          {
            title: "Validation",
            waitsOn: [1],
            tasks: [{ title: "Find tests", prompt: "test" }],
          },
        ],
      }),
    );

    expect(starts).toEqual(["1.1", "1.2", "2.1", "3.1"]);
    expect(prompts.get("1.2")).toContain("1.1:\nfinding 1.1");
    expect(prompts.get("2.1")).toContain("1.2:\nfinding 1.2");
    expect(output).toMatchObject({
      results: [
        { id: "1.1", outcome: "completed" },
        { id: "1.2", outcome: "completed" },
        { id: "2.1", outcome: "completed" },
        { id: "3.1", outcome: "completed" },
      ],
    });
    expect(progress[0]?.type).toBe("dag-started");
    if (progress[0]?.type === "dag-started") {
      expect(progress[0].concurrency).toBe(3);
      expect(progress[0].lanes[0].tasks.map((task) => task.id)).toEqual(["1.1", "1.2"]);
    }
    expect(progress.at(-1)?.type).toBe("dag-completed");
  });

  test("rejects cycles and unknown numeric lane dependencies before workers start", async () => {
    let workers = 0;
    const tool = createPlanningDagTool({
      concurrency: 2,
      async createWorker() {
        workers += 1;
        return { generate: async () => runResult("unused") };
      },
    });
    await expect(
      tool.execute(
        planningDagInputSchema.parse({
          lanes: [
            { title: "One", waitsOn: [2], tasks: [{ title: "A", prompt: "a" }] },
            { title: "Two", waitsOn: [1], tasks: [{ title: "B", prompt: "b" }] },
          ],
        }),
      ),
    ).rejects.toThrow("cycle");
    await expect(
      tool.execute(
        planningDagInputSchema.parse({
          lanes: [{ title: "One", waitsOn: [2], tasks: [{ title: "A", prompt: "a" }] }],
        }),
      ),
    ).rejects.toThrow("unknown lane");
    expect(workers).toBe(0);
  });

  test("reports failures and blocks downstream lanes", async () => {
    const progress: PlanningDagProgressEvent[] = [];
    const tool = createPlanningDagTool({
      concurrency: 2,
      onProgress: (event) => {
        progress.push(event);
      },
      async createWorker(task) {
        return {
          async generate() {
            if (task.id === "1.1") throw new Error("no evidence");
            return runResult("should not run");
          },
        };
      },
    });
    const output = await tool.execute(
      planningDagInputSchema.parse({
        lanes: [
          { title: "Research", tasks: [{ title: "Inspect", prompt: "inspect" }] },
          {
            title: "Design",
            waitsOn: [1],
            tasks: [{ title: "Design", prompt: "design" }],
          },
        ],
      }),
    );
    expect(output).toMatchObject({
      results: [
        { id: "1.1", outcome: "failed", error: "no evidence" },
        { id: "2.1", outcome: "blocked", error: "Blocked by: 1.1" },
      ],
    });
    expect(progress.map((event) => event.type)).toEqual([
      "dag-started",
      "task-started",
      "task-failed",
      "task-blocked",
      "dag-completed",
    ]);
  });
});
