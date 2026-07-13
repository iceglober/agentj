import z from "zod";
import { defineTool } from "../llm";
import type { RunResult } from "../llm";
import type { ChildSession, ChildSessionFinalizeResult } from "../session";

/** One autonomous child lane: prompt, commit message, optional stable id. */
export const subagentTaskSchema = z.object({
  prompt: z.string().min(1),
  commitMessage: z.string().min(1),
  id: z.string().min(1).optional(),
});

export type SubagentTask = z.infer<typeof subagentTaskSchema>;

/** Indexed form the worker pool runs internally and factories receive. */
export const indexedSubagentTaskSchema = subagentTaskSchema.extend({
  index: z.number().int().nonnegative(),
  id: z.string().min(1),
});

export type IndexedSubagentTask = z.infer<typeof indexedSubagentTaskSchema>;

export const subagentRecoverySchema = z.object({
  preserved: z.boolean(),
  reason: z.enum(["failure", "aborted", "uncertain"]).nullable(),
  parentRef: z.string().nullable(),
  head: z.string().nullable(),
  status: z.string().nullable(),
  worktreeRemoved: z.boolean().nullable(),
  branchDeleted: z.boolean().nullable(),
});

export type SubagentRecovery = z.infer<typeof subagentRecoverySchema>;

export const subagentTaskResultSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string(),
  outcome: z.enum(["changed", "clean", "failure", "aborted"]),
  branch: z.string().nullable(),
  path: z.string().nullable(),
  base: z.string().nullable(),
  commit: z.string().nullable(),
  text: z.string().nullable(),
  error: z.string().nullable(),
  recovery: subagentRecoverySchema,
});

export type SubagentTaskResult = z.infer<typeof subagentTaskResultSchema>;

export const subagentToolInputSchema = z.object({
  tasks: z.array(subagentTaskSchema).min(1),
  concurrency: z.number().int().positive().default(1),
});

export type SubagentToolInput = z.infer<typeof subagentToolInputSchema>;

export const subagentToolResultSchema = z.object({
  results: z.array(subagentTaskResultSchema),
});

export type SubagentToolResult = z.infer<typeof subagentToolResultSchema>;

export interface CreateChildSessionArgs {
  readonly id: string;
  readonly parentRef: string;
  readonly task: IndexedSubagentTask;
}

export interface SubagentRunner {
  generate(prompt: string, opts?: { abortSignal?: AbortSignal }): Promise<RunResult>;
}

export interface CreateChildAgentArgs {
  readonly task: IndexedSubagentTask;
  readonly session: ChildSession;
  readonly root: string;
  readonly role: "delegate";
  readonly allowDelegation: false;
}

export interface CreateSubagentToolOptions {
  /** Parent commit/ref every child worktree must fork from. */
  readonly parentRef: string;
  /** Hard ceiling for one tool invocation. Default: 4 lanes. */
  readonly maxConcurrency?: number;
  readonly createChildSession: (
    args: CreateChildSessionArgs,
  ) => Promise<ChildSession>;
  readonly createChildAgent: (args: CreateChildAgentArgs) => Promise<SubagentRunner>;
}

interface ToolExecuteOptions {
  abortSignal?: AbortSignal;
}

const DEFAULT_MAX_CONCURRENCY = 4;

const emptyRecovery = (
  preserved: boolean,
  reason: SubagentRecovery["reason"],
  parentRef: string | null,
): SubagentRecovery => ({
  preserved,
  reason,
  parentRef,
  head: null,
  status: null,
  worktreeRemoved: null,
  branchDeleted: null,
});

const toIndexedTasks = (tasks: SubagentTask[]): IndexedSubagentTask[] =>
  tasks.map((task, index) => ({
    ...task,
    index,
    id: task.id ?? `subagent-${index + 1}`,
  }));

const clampConcurrency = (
  requested: number,
  taskCount: number,
  maxConcurrency: number,
): number => Math.max(1, Math.min(requested, taskCount, maxConcurrency));

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAbort = (error: unknown, abortSignal?: AbortSignal): boolean =>
  abortSignal?.aborted === true ||
  (error instanceof Error && /abort/i.test(error.name));

const buildSuccessResult = (
  task: IndexedSubagentTask,
  run: RunResult,
  finalize: Extract<ChildSessionFinalizeResult, { outcome: "changed" | "clean" }>,
): SubagentTaskResult => ({
  index: task.index,
  id: task.id,
  outcome: finalize.outcome,
  branch: finalize.branch,
  path: finalize.path,
  base: finalize.base,
  commit: finalize.commit,
  text: run.text,
  error: null,
  recovery: {
    preserved: finalize.preserved,
    reason: null,
    parentRef: finalize.parentRef,
    head: finalize.head,
    status: finalize.status,
    worktreeRemoved: finalize.worktreeRemoved,
    branchDeleted: finalize.branchDeleted,
  },
});

const buildPreservedResult = (
  task: IndexedSubagentTask,
  outcome: "failure" | "aborted",
  text: string | null,
  error: string,
  finalize:
    | Extract<ChildSessionFinalizeResult, { outcome: "preserved" }>
    | null,
  session: Pick<ChildSession, "path" | "branch" | "base" | "parentRef"> | null,
): SubagentTaskResult => ({
  index: task.index,
  id: task.id,
  outcome,
  branch: finalize?.branch ?? session?.branch ?? null,
  path: finalize?.path ?? session?.path ?? null,
  base: finalize?.base ?? session?.base ?? null,
  commit: finalize?.commit ?? null,
  text,
  error,
  recovery:
    finalize === null
      ? emptyRecovery(true, outcome, session?.parentRef ?? null)
      : {
          preserved: finalize.preserved,
          reason: finalize.reason,
          parentRef: finalize.parentRef,
          head: finalize.head,
          status: finalize.status,
          worktreeRemoved: finalize.worktreeRemoved,
          branchDeleted: finalize.branchDeleted,
        },
});

const buildUncertainResult = (
  task: IndexedSubagentTask,
  outcome: "failure" | "aborted",
  text: string | null,
  error: string,
  session: Pick<ChildSession, "path" | "branch" | "base" | "parentRef">,
): SubagentTaskResult => ({
  index: task.index,
  id: task.id,
  outcome,
  branch: session.branch,
  path: session.path,
  base: session.base,
  commit: null,
  text,
  error,
  recovery: emptyRecovery(false, "uncertain", session.parentRef),
});

async function runLane(
  task: IndexedSubagentTask,
  options: CreateSubagentToolOptions,
  abortSignal?: AbortSignal,
): Promise<SubagentTaskResult> {
  let session: ChildSession | null = null;
  let run: RunResult | null = null;

  try {
    session = await options.createChildSession({
      id: task.id,
      parentRef: options.parentRef,
      task,
    });

    const child = await options.createChildAgent({
      task,
      session,
      root: session.path,
      role: "delegate",
      allowDelegation: false,
    });

    run = await child.generate(
      task.prompt,
      abortSignal ? { abortSignal } : undefined,
    );

    let finalized: ChildSessionFinalizeResult;
    try {
      finalized = await session.finalize({
        outcome: "success",
        commitMessage: task.commitMessage,
      });
    } catch (finalizeError) {
      return buildUncertainResult(
        task,
        "failure",
        run.text,
        `Session finalization failed: ${errorText(finalizeError)}`,
        session,
      );
    }

    if (finalized.outcome === "changed" || finalized.outcome === "clean") {
      return buildSuccessResult(task, run, finalized);
    }

    return buildPreservedResult(
      task,
      "failure",
      run.text,
      "Child run finished, but finalization was uncertain.",
      finalized,
      session,
    );
  } catch (error) {
    const outcome = isAbort(error, abortSignal) ? "aborted" : "failure";
    const detail = errorText(error);

    if (!session) {
      return {
        index: task.index,
        id: task.id,
        outcome,
        branch: null,
        path: null,
        base: null,
        commit: null,
        text: run?.text ?? null,
        error: detail,
        recovery: emptyRecovery(false, null, options.parentRef),
      };
    }

    try {
      const finalized = await session.finalize({ outcome, detail });
      return buildPreservedResult(
        task,
        outcome,
        run?.text ?? null,
        detail,
        finalized.outcome === "preserved" ? finalized : null,
        session,
      );
    } catch (finalizeError) {
      return buildUncertainResult(
        task,
        outcome,
        run?.text ?? null,
        `${detail} (finalize failed: ${errorText(finalizeError)})`,
        session,
      );
    }
  }
}

export function createSubagentTool(options: CreateSubagentToolOptions) {
  return defineTool({
    description:
      "Run multiple child agents in isolated worktrees and return ordered changeset metadata.",
    inputSchema: subagentToolInputSchema,
    async execute(
      input: SubagentToolInput,
      toolOptions?: unknown,
    ): Promise<SubagentToolResult> {
      const indexed = toIndexedTasks(input.tasks);
      const abortSignal = (toolOptions as ToolExecuteOptions | undefined)?.abortSignal;
      const results = new Array<SubagentTaskResult>(indexed.length);
      const concurrency = clampConcurrency(
        input.concurrency,
        indexed.length,
        options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      );

      let nextIndex = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          if (abortSignal?.aborted) {
            return;
          }

          const current = nextIndex;
          nextIndex += 1;
          if (current >= indexed.length) {
            return;
          }

          results[current] = await runLane(indexed[current], options, abortSignal);
        }
      });

      await Promise.all(workers);

      for (const task of indexed) {
        results[task.index] ??= {
          index: task.index,
          id: task.id,
          outcome: "aborted",
          branch: null,
          path: null,
          base: null,
          commit: null,
          text: null,
          error: "Aborted before this lane started.",
          recovery: emptyRecovery(false, null, options.parentRef),
        };
      }

      return { results };
    },
  });
}
