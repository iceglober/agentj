import type { SubagentProgressEvent } from "../agent/subagents";
import { truncateWithNotice } from "../truncation";

/**
 * Flat task-line rendering for the unified subagent DAG: feed progress events
 * in, get the current block of display lines out (empty once the DAG ends).
 * Pure state — the chat screen owns painting and the spinner cadence.
 */

const SPINNER = ["◐", "◓", "◑", "◒"];

const truncateLine = (value: string, maxLength: number): string =>
  truncateWithNotice(value.replace(/\r\n?|\n/gu, " "), maxLength);

interface TrackedTask {
  id: string;
  title: string;
  waitsOn: string[];
  /** Child model label (provider/model), present only when it differs from the parent's. */
  model?: string;
  /** Position in the dag-started task list — ordering tiebreak for unstarted tasks. */
  declarationIndex: number;
  /** Mint order of task-started — started tasks render in execution order. */
  startOrder?: number;
  state: "waiting" | "running" | "completed" | "failed" | "blocked";
  elapsedMs?: number;
  message?: string;
  usage?: { inputTokens: number; outputTokens: number; contextTokens: number };
}

/** 340 → "340ms", 2140 → "2.1s", 74_200 → "74.2s". */
export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

/** 456 → "456", 2437 → "2.4k", 432_312 → "432.3k". */
const formatTokens = (count: number): string =>
  count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;

const formatUsage = (usage: NonNullable<TrackedTask["usage"]>): string =>
  `in:${formatTokens(usage.inputTokens)}, out:${formatTokens(usage.outputTokens)}, ctx:${formatTokens(usage.contextTokens)}`;

export interface ProgressTracker {
  apply(event: SubagentProgressEvent): void;
  /** Current display block; empty when no DAG is live. */
  lines(frame?: number, indent?: number): string[];
  readonly live: boolean;
}

export interface ProgressUpdate {
  /** Current ephemeral live-region lines. */
  lines: string[];
  /** Final task lines to append to the transcript exactly once. */
  completedLines: string[];
}

/** Apply one event, retaining the final task state before dag-completed clears it. */
export function applyProgressEvent(
  tracker: ProgressTracker,
  event: SubagentProgressEvent,
  frame = 0,
  indent?: number,
): ProgressUpdate {
  const completedLines =
    event.type === "dag-completed" && tracker.live ? tracker.lines(frame, indent) : [];
  tracker.apply(event);
  return { lines: tracker.lines(frame, indent), completedLines };
}

export function createProgressTracker(): ProgressTracker {
  let tasks: TrackedTask[] = [];
  let live = false;
  let nextStartOrder = 0;

  return {
    get live() {
      return live;
    },

    apply(event) {
      switch (event.type) {
        case "dag-started":
          live = true;
          nextStartOrder = 0;
          tasks = event.tasks.map((task, index) => ({
            ...task,
            declarationIndex: index,
            state: "waiting",
          }));
          return;
        case "task-started": {
          const task = tasks.find((entry) => entry.id === event.id);
          if (task) {
            task.state = "running";
            task.startOrder = nextStartOrder++;
          }
          return;
        }
        case "task-usage": {
          const task = tasks.find((entry) => entry.id === event.id);
          if (task) {
            task.usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              contextTokens: event.contextTokens,
            };
          }
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
            task.message = event.message;
          }
          return;
        }
        case "dag-completed":
          live = false;
          tasks = [];
          return;
      }
    },

    lines(frame = 0, indent = 2) {
      if (!live) return [];
      const MAX_LEFT = 48;
      // Execution order: started tasks by start order, unstarted trail in
      // declaration order.
      const ordered = [...tasks].sort(
        (a, b) =>
          (a.startOrder ?? Infinity) - (b.startOrder ?? Infinity) ||
          a.declarationIndex - b.declarationIndex,
      );
      const rows = ordered.map((task) => {
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
        const outcome =
          task.state === "failed" || task.state === "blocked" ? ` (${task.state})` : "";
        let left = `${" ".repeat(indent)}${marker} ${task.id} ${task.title}${outcome}${waits}`;
        if (left.length > MAX_LEFT) left = `${left.slice(0, MAX_LEFT - 1)}…`;
        const elapsed = task.elapsedMs !== undefined ? formatDuration(task.elapsedMs) : "";
        const usage = task.usage ? formatUsage(task.usage) : "";
        // Model rides in the right column so long titles can't truncate it.
        const model = task.model ? `(${task.model})` : "";
        const right = [usage, elapsed, model].filter(Boolean).join("  ");
        return { left, right };
      });
      const width = Math.max(...rows.map((row) => row.left.length));
      return rows.flatMap((row, index) => {
        const task = ordered[index];
        const line = row.right ? `${row.left.padEnd(width + 2)}${row.right}` : row.left;
        if (!task?.message) return [line];
        const message = task.message.replace(/\r\n?|\n/gu, " ");
        const maxMessageLength = 120;
        const preview =
          message.length > maxMessageLength
            ? `${message.slice(0, maxMessageLength - 1)}…`
            : message;
        return [line, `${" ".repeat(indent + 2)}↳ ${preview}`];
      });
    },
  };
}
export const composeProgressLines = (state: {
  activeTools: Iterable<[number, { tool: string; detail: string }]>;
  dagBlocks: ReadonlyMap<number, string[]>;
  queued: string[];
  spinnerFrame: number;
}): string[] => {
  const frame = SPINNER[state.spinnerFrame % SPINNER.length] ?? "◐";
  const owned = new Set<number>();
  const toolRows: string[] = [];
  for (const [id, { tool, detail }] of state.activeTools) {
    toolRows.push(
      `  ${frame} ${tool}${detail && tool !== "run_subagents" ? ` ${truncateLine(detail, 40)}` : ""}`,
    );
    const block = state.dagBlocks.get(id);
    if (block) {
      owned.add(id);
      toolRows.push(...block);
    }
  }
  const orphanRows = [...state.dagBlocks]
    .filter(([id]) => !owned.has(id))
    .flatMap(([, block]) => block);
  return [...orphanRows, ...toolRows, ...state.queued];
};
