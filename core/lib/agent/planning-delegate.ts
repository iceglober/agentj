import z from "zod";
import type { RunResult } from "../llm";
import { defineTool } from "../llm";
import { scheduleTasks } from "./scheduler";

export const planningLaneTaskSchema = z.object({
  title: z.string().min(1).max(80),
  prompt: z.string().min(1),
});

export const planningLaneSchema = z.object({
  title: z.string().min(1).max(80),
  waitsOn: z.array(z.number().int().positive()).default([]),
  tasks: z.array(planningLaneTaskSchema).min(1).max(8),
});

export const planningDagInputSchema = z.object({
  lanes: z.array(planningLaneSchema).min(1).max(8),
});

export type PlanningDagInput = z.infer<typeof planningDagInputSchema>;

export interface PlanningTask {
  id: string;
  lane: number;
  sequence: number;
  laneTitle: string;
  title: string;
  prompt: string;
  dependsOn: string[];
}

export interface PlanningTaskResult {
  id: string;
  outcome: "completed" | "failed" | "blocked";
  text: string | null;
  error: string | null;
}

export type PlanningDagProgressEvent =
  | {
      type: "dag-started";
      concurrency: number;
      startedAt: number;
      lanes: Array<{
        id: number;
        title: string;
        waitsOn: number[];
        tasks: Array<{ id: string; title: string }>;
      }>;
    }
  | {
      type: "task-started";
      id: string;
      lane: number;
      title: string;
      startedAt: number;
    }
  | {
      type: "task-completed" | "task-failed" | "task-blocked";
      id: string;
      lane: number;
      title: string;
      elapsedMs: number;
      error?: string;
    }
  | { type: "dag-completed"; elapsedMs: number };

export interface PlanningWorker {
  generate(prompt: string, opts?: { abortSignal?: AbortSignal }): Promise<RunResult>;
}

export interface CreatePlanningDagToolOptions {
  concurrency: number;
  createWorker(task: PlanningTask): Promise<PlanningWorker>;
  onProgress?(event: PlanningDagProgressEvent): void | Promise<void>;
  now?: () => number;
}

function normalizeDag(input: PlanningDagInput): PlanningTask[] {
  const laneCount = input.lanes.length;
  for (const [index, lane] of input.lanes.entries()) {
    const laneId = index + 1;
    const seen = new Set<number>();
    for (const dependency of lane.waitsOn) {
      if (dependency > laneCount) {
        throw new Error(`Planning lane ${laneId} waits on unknown lane: ${dependency}`);
      }
      if (dependency === laneId) throw new Error(`Planning lane ${laneId} waits on itself`);
      if (seen.has(dependency)) {
        throw new Error(`Planning lane ${laneId} repeats dependency: ${dependency}`);
      }
      seen.add(dependency);
    }
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (laneId: number): void => {
    if (visiting.has(laneId)) throw new Error("Planning lane graph contains a cycle");
    if (visited.has(laneId)) return;
    visiting.add(laneId);
    for (const dependency of input.lanes[laneId - 1].waitsOn) visit(dependency);
    visiting.delete(laneId);
    visited.add(laneId);
  };
  for (let laneId = 1; laneId <= laneCount; laneId += 1) visit(laneId);

  return input.lanes.flatMap((lane, laneIndex) => {
    const laneId = laneIndex + 1;
    return lane.tasks.map((task, taskIndex): PlanningTask => {
      const sequence = taskIndex + 1;
      const dependsOn =
        taskIndex > 0
          ? [`${laneId}.${taskIndex}`]
          : lane.waitsOn.map((dependency) => {
              const terminalSequence = input.lanes[dependency - 1].tasks.length;
              return `${dependency}.${terminalSequence}`;
            });
      return {
        id: `${laneId}.${sequence}`,
        lane: laneId,
        sequence,
        laneTitle: lane.title,
        title: task.title,
        prompt: task.prompt,
        dependsOn,
      };
    });
  });
}

export function createPlanningDagTool(options: CreatePlanningDagToolOptions) {
  return defineTool({
    description:
      "Run read-only planning subagents in serial lanes. Lanes without dependencies run concurrently; waitsOn references one-based lane numbers.",
    inputSchema: planningDagInputSchema,
    async execute(input, toolOptions?: unknown): Promise<{ results: PlanningTaskResult[] }> {
      const tasks = normalizeDag(input);
      const now = options.now ?? Date.now;
      const dagStartedAt = now();
      const emit = async (event: PlanningDagProgressEvent): Promise<void> => {
        await options.onProgress?.(event);
      };
      await emit({
        type: "dag-started",
        concurrency: options.concurrency,
        startedAt: dagStartedAt,
        lanes: input.lanes.map((lane, laneIndex) => ({
          id: laneIndex + 1,
          title: lane.title,
          waitsOn: lane.waitsOn,
          tasks: lane.tasks.map((task, taskIndex) => ({
            id: `${laneIndex + 1}.${taskIndex + 1}`,
            title: task.title,
          })),
        })),
      });

      const abortSignal = (toolOptions as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const concurrency = Math.min(options.concurrency, tasks.length);
      const results = await scheduleTasks<PlanningTask, PlanningTaskResult>({
        tasks,
        concurrency,
        abortSignal,
        id: (task) => task.id,
        dependencies: (task) => task.dependsOn,
        dependencySucceeded: (result) => result.outcome === "completed",
        blocked: async (task, failedDependencies) => {
          const error = `Blocked by: ${failedDependencies.join(", ")}`;
          await emit({
            type: "task-blocked",
            id: task.id,
            lane: task.lane,
            title: task.title,
            elapsedMs: 0,
            error,
          });
          return { id: task.id, outcome: "blocked", text: null, error };
        },
        run: async (task, completed) => {
          const startedAt = now();
          await emit({
            type: "task-started",
            id: task.id,
            lane: task.lane,
            title: task.title,
            startedAt,
          });
          try {
            if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
            const worker = await options.createWorker(task);
            const prerequisiteFindings = task.dependsOn
              .map((dependency) => completed.get(dependency))
              .filter((result): result is PlanningTaskResult => result !== undefined)
              .map((result) => `${result.id}:\n${result.text ?? result.error ?? "No finding"}`)
              .join("\n\n");
            const prompt = prerequisiteFindings
              ? `${task.prompt}\n\nPrerequisite findings:\n${prerequisiteFindings}`
              : task.prompt;
            const result = await worker.generate(prompt, abortSignal ? { abortSignal } : undefined);
            await emit({
              type: "task-completed",
              id: task.id,
              lane: task.lane,
              title: task.title,
              elapsedMs: now() - startedAt,
            });
            return { id: task.id, outcome: "completed", text: result.text, error: null };
          } catch (error) {
            if (
              abortSignal?.aborted ||
              ((error instanceof DOMException || error instanceof Error) &&
                error.name === "AbortError")
            ) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            await emit({
              type: "task-failed",
              id: task.id,
              lane: task.lane,
              title: task.title,
              elapsedMs: now() - startedAt,
              error: message,
            });
            return { id: task.id, outcome: "failed", text: null, error: message };
          }
        },
      });

      await emit({ type: "dag-completed", elapsedMs: now() - dagStartedAt });
      return { results };
    },
  });
}
