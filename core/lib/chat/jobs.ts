import type { ChatMode } from "../session/log";
import type { ChatEvent, JobView } from "./events";

/**
 * Background jobs: one detached agent run per job, started by the USER (input
 * beginning with `&`), never by the model. The composition root injects the
 * executor — plan jobs run a read-only agent in the session cwd; build jobs
 * run inside a child worktree via the same snapshot→integrate path as
 * subagents, so they cannot race the checkout or the foreground turn.
 * Completions surface twice: a transcript event now, and a notice prepended
 * to the next user turn so the model learns the outcome without any push
 * mechanism. No persistence across restarts — preserved branches are the
 * durable artifact of an interrupted build job.
 */

export interface RunJobArgs {
  mode: ChatMode;
  prompt: string;
  abortSignal: AbortSignal;
}

export interface JobOutcome {
  text: string;
  /** Branch preserving the work when integration was blocked. */
  branch?: string;
}

export interface JobRunnerDependencies {
  runJob(args: RunJobArgs): Promise<JobOutcome>;
  onEvent?(event: ChatEvent): void | Promise<void>;
  /** Receives one summary line per finished job for the next user turn. */
  addTurnNotice(text: string): void;
  now?: () => number;
}

export interface JobRunner {
  start(mode: ChatMode, prompt: string): JobView;
  list(): JobView[];
  abort(id: string): boolean;
  /** Abort everything still running (session exit). */
  dispose(): void;
}

const summarize = (job: JobView): string => {
  const seconds = job.endedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : 0;
  const head = `[${job.id}] ${job.status} in ${seconds}s — ${job.prompt.slice(0, 60)}`;
  const firstLine = job.resultText?.split("\n").find((line) => line.trim()) ?? "";
  const branch = job.branch ? ` (work preserved on ${job.branch})` : "";
  return `${head}${firstLine ? `: ${firstLine.slice(0, 120)}` : ""}${branch}`;
};

export function createJobRunner(deps: JobRunnerDependencies): JobRunner {
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, { view: JobView; abort: AbortController }>();
  let counter = 0;

  const emit = (event: ChatEvent): void => {
    void deps.onEvent?.(event);
  };

  return {
    start(mode, prompt) {
      counter += 1;
      const abort = new AbortController();
      const view: JobView = {
        id: `j${counter}`,
        mode,
        prompt,
        status: "running",
        startedAt: now(),
      };
      jobs.set(view.id, { view, abort });
      emit({ type: "job-started", job: { ...view } });

      void deps
        .runJob({ mode, prompt, abortSignal: abort.signal })
        .then((outcome) => {
          view.status = abort.signal.aborted ? "aborted" : "done";
          view.resultText = outcome.text;
          if (outcome.branch) view.branch = outcome.branch;
        })
        .catch((error) => {
          view.status = abort.signal.aborted ? "aborted" : "failed";
          view.resultText = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          view.endedAt = now();
          emit({ type: "job-finished", job: { ...view } });
          deps.addTurnNotice(summarize(view));
        });

      return { ...view };
    },

    list() {
      return [...jobs.values()].map((entry) => ({ ...entry.view }));
    },

    abort(id) {
      const entry = jobs.get(id);
      if (!entry || entry.view.status !== "running") return false;
      entry.abort.abort();
      return true;
    },

    dispose() {
      for (const entry of jobs.values()) {
        if (entry.view.status === "running") entry.abort.abort();
      }
    },
  };
}
