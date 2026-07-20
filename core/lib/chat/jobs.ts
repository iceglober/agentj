import { describeToolInput } from "../agent/permissions";
import type { RunStep } from "../llm";
import { parseCompletionReport } from "../report";
import type { ChatMode } from "../session/log";
import type { ChatEvent, JobView } from "./events";

/**
 * Background jobs: one detached agent run per job, started by the user (input
 * beginning with `&`) or by the primary agent through its run_job tool — the
 * tool exists so "wait for CI, then fix it" detaches here instead of
 * sleep-polling in the foreground turn. The composition root injects the
 * executor — plan jobs run a read-only agent in the session cwd; build jobs
 * run inside a child worktree via the same snapshot→integrate path as
 * subagents, so they cannot race the checkout or the foreground turn.
 * Completions surface twice: a transcript event now, and a notice prepended
 * to the next user turn so the model learns the outcome without any push
 * mechanism. A job may also carry a soft timeout: when it is still running at
 * the deadline, `ping` fires once — the job keeps running, and the agent
 * decides whether to renew the deadline or abort. No persistence across
 * restarts — preserved branches are the durable artifact of an interrupted
 * build job.
 */

export interface RunJobArgs {
  /** The job's id ("j1", …) — lets executors label permission asks. */
  id: string;
  mode: ChatMode;
  prompt: string;
  abortSignal: AbortSignal;
  /** Feed the runner the job's live steps so `inspect` can show its recent
   *  tool activity. Executors that cannot stream steps may omit calls. */
  onStep?(step: RunStep): void;
}

export interface JobOutcome {
  text: string;
  /** A resolved executor failure; rejected promises remain failures too. */
  status?: "failed";
  /** Branch preserving work after a failed child or blocked integration. */
  branch?: string;
  /** Non-fatal cleanup issues after job work completed. */
  warnings?: string[];
}

export interface JobRunnerDependencies {
  runJob(args: RunJobArgs): Promise<JobOutcome>;
  onEvent?(event: ChatEvent): void | Promise<void>;
  /** Receives one summary line per finished job for the next user turn. */
  addTurnNotice(text: string): void;
  /** Runs after the completion notice is queued; jobs never mutate parent todos. */
  onJobCompleted?(job: JobView): void | Promise<void>;
  /** Fires once when a job passes its soft timeout while still running. */
  ping?(job: JobView): void;
  now?: () => number;
}

export interface JobStartOptions {
  /** Fire `ping` if the job is still running after this long. Advisory: the
   *  job keeps running; `renewSoftTimeout` re-arms the deadline. */
  softTimeoutMs?: number;
}

export interface JobInspection extends JobView {
  /** Bounded tail of the job's tool calls, oldest first. */
  recentActivity: string[];
}

export interface JobRunner {
  start(mode: ChatMode, prompt: string, options?: JobStartOptions): JobView;
  list(): JobView[];
  /** The job plus its recent tool activity — enough to judge a slow job. */
  inspect(id: string): JobInspection | undefined;
  /** Re-arm the soft-timeout ping this far from now. False unless running. */
  renewSoftTimeout(id: string, softTimeoutMs: number): boolean;
  abort(id: string): boolean;
  /** Abort everything still running (session exit). */
  dispose(): void;
}

const summarize = (job: JobView): string => {
  const seconds = job.endedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : 0;
  const status =
    job.status === "done" ? "finished" : job.status === "failed" ? "failed" : "aborted";
  const head = `[${job.id}] ${status} in ${seconds}s — ${job.prompt.slice(0, 60)}`;
  const firstLine = job.resultText?.split("\n").find((line) => line.trim()) ?? "";
  const branch = job.branch ? ` (work preserved on ${job.branch})` : "";
  const warning = job.warnings?.[0] ? ` (warning: ${job.warnings[0].slice(0, 120)})` : "";
  return `${head}${firstLine ? `: ${firstLine.slice(0, 120)}` : ""}${branch}${warning}`;
};

/** Tool calls kept per job for `inspect`; older calls collapse to a count. */
const ACTIVITY_LIMIT = 30;

interface JobEntry {
  view: JobView;
  abort: AbortController;
  activity: string[];
  droppedActivity: number;
  softTimer?: ReturnType<typeof setTimeout>;
}

export function createJobRunner(deps: JobRunnerDependencies): JobRunner {
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, JobEntry>();
  let counter = 0;

  const emit = (event: ChatEvent): void => {
    void deps.onEvent?.(event);
  };

  const recordStep = (entry: JobEntry, step: RunStep): void => {
    for (const call of step.toolCalls) {
      const detail = describeToolInput(call.input);
      entry.activity.push(detail ? `${call.name} ${detail.slice(0, 120)}` : call.name);
    }
    const excess = entry.activity.length - ACTIVITY_LIMIT;
    if (excess > 0) {
      entry.activity.splice(0, excess);
      entry.droppedActivity += excess;
    }
  };

  const armSoftTimeout = (entry: JobEntry, softTimeoutMs: number): void => {
    clearTimeout(entry.softTimer);
    entry.view.softTimeoutAt = now() + softTimeoutMs;
    entry.softTimer = setTimeout(() => {
      if (entry.view.status === "running") deps.ping?.({ ...entry.view });
    }, softTimeoutMs);
    entry.softTimer.unref?.();
  };

  return {
    start(mode, prompt, options) {
      counter += 1;
      const abort = new AbortController();
      const view: JobView = {
        id: `j${counter}`,
        mode,
        prompt,
        status: "running",
        startedAt: now(),
      };
      const entry: JobEntry = { view, abort, activity: [], droppedActivity: 0 };
      jobs.set(view.id, entry);
      if (options?.softTimeoutMs !== undefined) armSoftTimeout(entry, options.softTimeoutMs);
      emit({ type: "job-started", job: { ...view } });

      void deps
        .runJob({
          id: view.id,
          mode,
          prompt,
          abortSignal: abort.signal,
          onStep: (step) => recordStep(entry, step),
        })
        .then((outcome) => {
          const completion = parseCompletionReport(outcome.text);
          view.status = abort.signal.aborted
            ? "aborted"
            : (outcome.status ?? (completion && completion.status !== "done" ? "failed" : "done"));
          view.resultText = completion?.summary ?? outcome.text;
          if (completion) view.completion = completion;
          if (outcome.branch) view.branch = outcome.branch;
          if (outcome.warnings?.length) view.warnings = outcome.warnings;
        })
        .catch((error) => {
          view.status = abort.signal.aborted ? "aborted" : "failed";
          view.resultText = error instanceof Error ? error.message : String(error);
        })
        .finally(async () => {
          clearTimeout(entry.softTimer);
          view.endedAt = now();
          emit({ type: "job-finished", job: { ...view } });
          deps.addTurnNotice(summarize(view));
          try {
            await deps.onJobCompleted?.({ ...view });
          } catch (error) {
            view.warnings = [
              ...(view.warnings ?? []),
              `Could not resume session work: ${error instanceof Error ? error.message : String(error)}`,
            ];
          }
        });

      return { ...view };
    },

    list() {
      return [...jobs.values()].map((entry) => ({ ...entry.view }));
    },

    inspect(id) {
      const entry = jobs.get(id);
      if (!entry) return undefined;
      return {
        ...entry.view,
        recentActivity: [
          ...(entry.droppedActivity > 0
            ? [`… ${entry.droppedActivity} earlier tool calls omitted`]
            : []),
          ...entry.activity,
        ],
      };
    },

    renewSoftTimeout(id, softTimeoutMs) {
      const entry = jobs.get(id);
      if (entry?.view.status !== "running") return false;
      armSoftTimeout(entry, softTimeoutMs);
      return true;
    },

    abort(id) {
      const entry = jobs.get(id);
      if (entry?.view.status !== "running") return false;
      entry.abort.abort();
      return true;
    },

    dispose() {
      for (const entry of jobs.values()) {
        clearTimeout(entry.softTimer);
        if (entry.view.status === "running") entry.abort.abort();
      }
    },
  };
}
