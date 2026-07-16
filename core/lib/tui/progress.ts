import type { SubagentProgressEvent } from "../agent/subagents";

/**
 * Flat task-line rendering for the unified subagent DAG: feed progress events
 * in, get the current block of display lines out (empty once the DAG ends).
 * Pure state — the chat screen owns painting and the spinner cadence.
 */

const SPINNER = ["◐", "◓", "◑", "◒"];

interface TrackedTask {
  id: string;
  title: string;
  waitsOn: string[];
  state: "waiting" | "running" | "completed" | "failed" | "blocked";
  elapsedMs?: number;
}

export interface ProgressTracker {
  apply(event: SubagentProgressEvent): void;
  /** Current display block; empty when no DAG is live. */
  lines(frame?: number): string[];
  readonly live: boolean;
}

export function createProgressTracker(): ProgressTracker {
  let tasks: TrackedTask[] = [];
  let live = false;

  return {
    get live() {
      return live;
    },

    apply(event) {
      switch (event.type) {
        case "dag-started":
          live = true;
          tasks = event.tasks.map((task) => ({ ...task, state: "waiting" }));
          return;
        case "task-started": {
          const task = tasks.find((entry) => entry.id === event.id);
          if (task) task.state = "running";
          return;
        }
        case "task-completed":
        case "task-failed":
        case "task-blocked": {
          const task = tasks.find((entry) => entry.id === event.id);
          if (task) {
            task.state =
              event.type === "task-completed"
                ? "completed"
                : event.type === "task-failed"
                  ? "failed"
                  : "blocked";
            task.elapsedMs = event.elapsedMs;
          }
          return;
        }
        case "dag-completed":
          live = false;
          tasks = [];
          return;
      }
    },

    lines(frame = 0) {
      if (!live) return [];
      return tasks.map((task) => {
        const marker =
          task.state === "completed"
            ? "✓"
            : task.state === "failed" || task.state === "blocked"
              ? "x"
              : task.state === "running"
                ? (SPINNER[frame % SPINNER.length] ?? "◐")
                : "·";
        const waits =
          task.state === "waiting" && task.waitsOn.length > 0
            ? ` · waits on ${task.waitsOn.join(", ")}`
            : "";
        const elapsed =
          task.elapsedMs !== undefined ? `  ${(task.elapsedMs / 1000).toFixed(1)}s` : "";
        return `  ${marker} ${task.id} ${task.title}${waits}${elapsed}`;
      });
    },
  };
}
