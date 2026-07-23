import z from "zod";
import type { RunResult, RunStep } from "../llm";
import { defineTool } from "../llm";
import type { ChildSession, ChildSessionFinalizeResult } from "../session";
import { scheduleTasks } from "./scheduler";

/**
 * The unified run_subagents tool: one flat task-level DAG over scheduleTasks,
 * with capability injected by the composition root according to the parent's
 * mode — plan mode fans out read-only researchers in the parent's cwd; build
 * mode fans out autonomous children in isolated worktrees whose commits are
 * integrated back as a batch. Replaces the separate planning-delegate (lanes)
 * and delegate (independent worktree lanes) tools; lanes were sugar over what
 * the scheduler already supports.
 */

export const subagentTaskSchema = z.object({
  id: z.string().min(1).max(32).optional(),
  title: z.string().min(1).max(80),
  prompt: z.string().min(1),
  /** Task ids that must complete first; their findings are fed into this prompt. */
  waitsOn: z.array(z.string()).default([]),
  /** Build mode: commit message for the child's changeset. Defaults from title. */
  commitMessage: z.string().min(1).optional(),
});
export type SubagentTaskInput = z.infer<typeof subagentTaskSchema>;

export const subagentsInputSchema = z.object({
  tasks: z.array(subagentTaskSchema).min(1).max(16),
});
export type SubagentsInput = z.infer<typeof subagentsInputSchema>;

/** A low-friction path for one bounded task; the scheduler still owns execution. */
export const runOneSubagentInputSchema = z.object({
  prompt: z.string().min(1),
});
export type RunOneSubagentInput = z.infer<typeof runOneSubagentInputSchema>;

export interface NormalizedSubagentTask {
  id: string;
  index: number;
  title: string;
  prompt: string;
  waitsOn: string[];
  commitMessage: string;
}

export const subagentResultSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  outcome: z.enum(["completed", "changed", "clean", "failed", "blocked", "aborted"]),
  text: z.string().nullable(),
  error: z.string().nullable(),
  /** Build-mode changeset metadata; null for research children. */
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  /** Build-mode recovery evidence when work was preserved on a branch. */
  preserved: z.boolean(),
  /** Cleanup warnings after the child result was safely verified. */
  warnings: z.array(z.string()),
});
export type SubagentResult = z.infer<typeof subagentResultSchema>;

export const subagentsResultSchema = z.object({
  results: z.array(subagentResultSchema),
  integration: z
    .object({
      outcome: z.enum(["applied", "clean", "blocked"]),
      detail: z.string().nullable(),
    })
    .optional(),
});
export type SubagentsResult = z.infer<typeof subagentsResultSchema>;

/** Map unified results onto the git-integration contract (failed/blocked → failure). */
export function toGitDelegationResults(results: readonly SubagentResult[]): Array<{
  index: number;
  outcome: "changed" | "clean" | "failure" | "aborted";
  commit: string | null;
  branch: string | null;
  preserved: boolean;
}> {
  return results.map((result) => ({
    index: result.index,
    outcome:
      result.outcome === "changed" || result.outcome === "clean"
        ? result.outcome
        : result.outcome === "aborted"
          ? "aborted"
          : "failure",
    commit: result.commit,
    branch: result.branch,
    preserved: result.preserved,
  }));
}

export type SubagentProgressEvent = (
  | {
      type: "dag-started";
      concurrency: number;
      startedAt: number;
      tasks: Array<{ id: string; title: string; waitsOn: string[]; model?: string }>;
    }
  | { type: "task-started"; id: string; title: string; startedAt: number }
  | {
      /** Live cumulative token usage; ctx is the latest request's input size. */
      type: "task-usage";
      id: string;
      inputTokens: number;
      outputTokens: number;
      contextTokens: number;
    }
  | {
      type: "task-completed" | "task-failed" | "task-blocked";
      id: string;
      title: string;
      elapsedMs: number;
      /** Final worker response on success, or the failure/blocking reason. */
      message: string;
      error?: string;
    }
  | { type: "dag-completed"; elapsedMs: number }
) & {
  /** ToolActivity id of the run_subagents call that owns this DAG, when the
   *  tool ran under an activity wrapper — lets a UI nest DAG rows under the
   *  owning tool row and keep concurrent DAGs apart. */
  parentActivityId?: number;
};

export interface SubagentRunner {
  generate(
    prompt: string,
    opts?: { abortSignal?: AbortSignal; onStep?: (step: RunStep) => void },
  ): Promise<RunResult>;
}

export interface DelegationWiring {
  /** Parent commit/ref every child worktree forks from (prepareBatch overrides). */
  readonly parentRef: string;
  readonly createChildSession: (args: {
    id: string;
    parentRef: string;
    task: NormalizedSubagentTask;
  }) => Promise<ChildSession>;
  readonly createChildAgent: (args: {
    task: NormalizedSubagentTask;
    session: ChildSession;
    root: string;
    abortSignal?: AbortSignal;
  }) => Promise<SubagentRunner>;
  readonly prepareBatch?: () => Promise<{
    parentRef: string;
    createChildSession?: DelegationWiring["createChildSession"];
    integrate(results: readonly SubagentResult[]): Promise<{
      outcome: "applied" | "clean" | "blocked";
      detail: string | null;
    }>;
  }>;
}

/** Capability follows the parent's mode; the composition root injects one arm. */
export type SubagentExecution =
  | { kind: "research"; createWorker(task: NormalizedSubagentTask): Promise<SubagentRunner> }
  | ({ kind: "delegation" } & DelegationWiring);

export interface CreateSubagentsToolOptions {
  execution: SubagentExecution;
  /** Concurrent children ceiling. Default 4. */
  concurrency?: number;
  /** Child model label (e.g. "azure/gpt-5-mini") stamped on dag-started task
   *  entries — set by the composition root only when tier routing gives the
   *  children a different model than the parent's. */
  model?: string;
  onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 4;

const runOneSubagentTitle = (prompt: string): string => {
  const firstLine = prompt.trim().split(/\r?\n/u)[0] ?? "";
  return firstLine.slice(0, 80) || "Delegated task";
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAbort = (error: unknown, abortSignal?: AbortSignal): boolean =>
  abortSignal?.aborted === true || (error instanceof Error && /abort/i.test(error.name));

/** Ids default t1..tN; waitsOn must reference known, non-self, acyclic ids. */
export function normalizeSubagentTasks(input: SubagentsInput): NormalizedSubagentTask[] {
  const tasks = input.tasks.map(
    (task, index): NormalizedSubagentTask => ({
      id: task.id ?? `t${index + 1}`,
      index,
      title: task.title,
      prompt: task.prompt,
      waitsOn: task.waitsOn,
      commitMessage: task.commitMessage ?? `glorious subagent: ${task.title.slice(0, 64)}`,
    }),
  );

  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("Subagent task ids must be unique");
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dependency of task.waitsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`Task ${task.id} waits on unknown task: ${dependency}`);
      }
      if (dependency === task.id) throw new Error(`Task ${task.id} waits on itself`);
      if (seen.has(dependency))
        throw new Error(`Task ${task.id} repeats dependency: ${dependency}`);
      seen.add(dependency);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Subagent task graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.waitsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);

  return tasks;
}

const withFindings = (
  task: NormalizedSubagentTask,
  completed: ReadonlyMap<string, SubagentResult>,
): string => {
  const findings = task.waitsOn
    .map((dependency) => completed.get(dependency))
    .filter((result): result is SubagentResult => result !== undefined)
    .map((result) => `${result.id}:\n${result.text ?? result.error ?? "No finding"}`)
    .join("\n\n");
  return findings ? `${task.prompt}\n\nPrerequisite findings:\n${findings}` : task.prompt;
};

const baseResult = (
  task: NormalizedSubagentTask,
  outcome: SubagentResult["outcome"],
  over: Partial<SubagentResult> = {},
): SubagentResult => ({
  id: task.id,
  index: task.index,
  title: task.title,
  outcome,
  text: null,
  error: null,
  branch: null,
  commit: null,
  preserved: false,
  warnings: [],
  ...over,
});

/** Build-mode lane: worktree child → finalize (commit or preserve) → metadata. */
async function runDelegationTask(
  task: NormalizedSubagentTask,
  prompt: string,
  wiring: DelegationWiring,
  abortSignal?: AbortSignal,
  onStep?: (step: RunStep) => void,
): Promise<SubagentResult> {
  let session: ChildSession | null = null;
  let run: RunResult | null = null;
  try {
    session = await wiring.createChildSession({ id: task.id, parentRef: wiring.parentRef, task });
    const child = await wiring.createChildAgent({ task, session, root: session.path, abortSignal });
    run = await child.generate(prompt, { abortSignal, onStep });

    let finalized: ChildSessionFinalizeResult;
    try {
      finalized = await session.finalize({ outcome: "success", commitMessage: task.commitMessage });
    } catch (finalizeError) {
      return baseResult(task, "failed", {
        text: run.text,
        error: `Session finalization failed: ${errorText(finalizeError)}`,
        branch: session.branch,
        preserved: true,
      });
    }
    if (finalized.outcome === "changed" || finalized.outcome === "clean") {
      return baseResult(task, finalized.outcome, {
        text: run.text,
        branch: finalized.branch,
        commit: finalized.commit,
        preserved: finalized.preserved,
        warnings: finalized.warnings ?? [],
      });
    }
    return baseResult(task, "failed", {
      text: run.text,
      error: finalized.detail ?? "Child run finished, but finalization was uncertain.",
      branch: finalized.branch ?? session.branch,
      commit: finalized.commit,
      preserved: true,
    });
  } catch (error) {
    const outcome = isAbort(error, abortSignal) ? "aborted" : "failed";
    const detail = errorText(error);
    if (!session) return baseResult(task, outcome, { error: detail });
    try {
      const finalized = await session.finalize({
        outcome: outcome === "aborted" ? "aborted" : "failure",
        detail,
      });
      return baseResult(task, outcome, {
        text: run?.text ?? null,
        error: detail,
        branch: finalized.outcome === "preserved" ? finalized.branch : session.branch,
        preserved: finalized.outcome === "preserved" ? finalized.preserved : false,
      });
    } catch (finalizeError) {
      return baseResult(task, outcome, {
        text: run?.text ?? null,
        error: `${detail} (finalize failed: ${errorText(finalizeError)})`,
        branch: session.branch,
        preserved: true,
      });
    }
  }
}

export function createRunOneSubagentTool(options: CreateSubagentsToolOptions) {
  const subagents = createSubagentsTool(options);
  const research = options.execution.kind === "research";
  return defineTool({
    description: research
      ? "Delegate one bounded read-only research task to a fresh-context subagent. Use this for a single independent question; use run_subagents for a DAG."
      : "Delegate one bounded implementation task to an isolated-worktree subagent and integrate its changes. Use this for one independent task; use run_subagents for a DAG.",
    inputSchema: runOneSubagentInputSchema,
    execute: (input: RunOneSubagentInput, toolOptions?: unknown) =>
      subagents.execute(
        {
          tasks: [{ title: runOneSubagentTitle(input.prompt), prompt: input.prompt, waitsOn: [] }],
        },
        toolOptions,
      ),
  });
}

export async function runSubagentTasks(
  options: CreateSubagentsToolOptions,
  input: SubagentsInput,
  toolOptions?: unknown,
): Promise<SubagentsResult> {
  const tasks = normalizeSubagentTasks(input);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { abortSignal, activityId: parentActivityId } =
    (toolOptions as { abortSignal?: AbortSignal; activityId?: number } | undefined) ?? {};
  const emit = async (event: SubagentProgressEvent): Promise<void> => {
    await options.onProgress?.(
      parentActivityId === undefined ? event : { ...event, parentActivityId },
    );
  };
  await emit({
    type: "dag-started",
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    startedAt,
    tasks: tasks.map(({ id, title, waitsOn }) => ({
      id,
      title,
      waitsOn,
      ...(options.model ? { model: options.model } : {}),
    })),
  });

  const execution = options.execution;
  const prepared = execution.kind === "delegation" ? await execution.prepareBatch?.() : null;
  const wiring: DelegationWiring | null =
    execution.kind === "delegation"
      ? {
          ...execution,
          ...(prepared
            ? {
                parentRef: prepared.parentRef,
                createChildSession: prepared.createChildSession ?? execution.createChildSession,
              }
            : {}),
        }
      : null;

  const results = await scheduleTasks<NormalizedSubagentTask, SubagentResult>({
    tasks,
    concurrency: Math.min(tasks.length, options.concurrency ?? DEFAULT_CONCURRENCY),
    abortSignal,
    id: (task) => task.id,
    dependencies: (task) => task.waitsOn,
    dependencySucceeded: (result) =>
      result.outcome === "completed" || result.outcome === "changed" || result.outcome === "clean",
    blocked: async (task, failedDependencies) => {
      const error = `Blocked by: ${failedDependencies.join(", ")}`;
      await emit({
        type: "task-blocked",
        id: task.id,
        title: task.title,
        elapsedMs: 0,
        message: error,
        error,
      });
      return baseResult(task, "blocked", { error });
    },
    abortedBeforeStart: (task) =>
      baseResult(task, "aborted", { error: "Aborted before this task started." }),
    run: async (task, completed) => {
      const taskStartedAt = now();
      await emit({
        type: "task-started",
        id: task.id,
        title: task.title,
        startedAt: taskStartedAt,
      });
      let inputTokens = 0;
      let outputTokens = 0;
      const onStep = (step: RunStep): void => {
        if (!step.usage) return;
        inputTokens += step.usage.inputTokens;
        outputTokens += step.usage.outputTokens;
        void emit({
          type: "task-usage",
          id: task.id,
          inputTokens,
          outputTokens,
          contextTokens: step.usage.inputTokens,
        });
      };
      const prompt = withFindings(task, completed);
      let result: SubagentResult;
      if (wiring) {
        result = await runDelegationTask(task, prompt, wiring, abortSignal, onStep);
      } else if (execution.kind === "research") {
        try {
          if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
          const worker = await execution.createWorker(task);
          const run = await worker.generate(prompt, { abortSignal, onStep });
          result = baseResult(task, "completed", { text: run.text });
        } catch (error) {
          if (isAbort(error, abortSignal)) throw error;
          result = baseResult(task, "failed", { error: errorText(error) });
        }
      } else {
        result = baseResult(task, "failed", { error: "No execution wiring" });
      }
      const elapsedMs = now() - taskStartedAt;
      const eventType =
        result.outcome === "failed" || result.outcome === "aborted"
          ? "task-failed"
          : "task-completed";
      await emit({
        type: eventType,
        id: task.id,
        title: task.title,
        elapsedMs,
        message:
          result.error ??
          result.text ??
          (eventType === "task-completed" ? "Completed." : "Task failed."),
        ...(result.error ? { error: result.error } : {}),
      });
      return result;
    },
  });

  await emit({ type: "dag-completed", elapsedMs: now() - startedAt });
  return {
    results,
    ...(prepared ? { integration: await prepared.integrate(results) } : {}),
  };
}
export function createSubagentsTool(options: CreateSubagentsToolOptions) {
  const research = options.execution.kind === "research";
  return defineTool({
    description: research
      ? "Fan out read-only research subagents as a task DAG. waitsOn lists task ids that must finish first; their findings are threaded into dependent prompts."
      : "Fan out autonomous subagents as a task DAG, each in an isolated worktree; completed changesets are integrated back as a batch. waitsOn lists task ids that must finish first.",
    inputSchema: subagentsInputSchema,
    execute: (input: SubagentsInput, toolOptions?: unknown) =>
      runSubagentTasks(options, input, toolOptions),
  });
}
