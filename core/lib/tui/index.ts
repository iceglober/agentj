import { stderr as processStderr, stdout as processStdout } from "node:process";

import type { ConversationEvent, ConversationOutcome } from "../app/conversation";
import type { TaskRunSessionIdentity } from "../app/run";

export {
  type CreatePromptUiOptions,
  createPromptUi,
  type InteractiveInputGate,
  type PromptIo,
  type PromptUi,
  type TextPromptEditor,
  type TextPromptRequest,
} from "./prompt-input";
export {
  type CreateTerminalPromptEditorOptions,
  createTerminalPromptEditor,
  renderEditorLayout,
} from "./terminal-editor";

export interface TerminalWriter {
  write(text: string): void;
}

export interface TerminalWriters {
  stdout: TerminalWriter;
  stderr: TerminalWriter;
}

export type ColorMode = "auto" | boolean;

export interface TranscriptRenderer {
  renderPrompt(): void;
  renderEvent(event: ConversationEvent): void;
  renderOutcome(outcome: ConversationOutcome): void;
}

export interface CreateTranscriptRendererOptions {
  task: string;
  writers?: Partial<TerminalWriters>;
  color?: ColorMode;
  isTty?: boolean;
  maxPayloadLength?: number;
  terminalWidth?: number | (() => number);
  spinnerIntervalMs?: number;
  now?: () => number;
}

export const DEFAULT_MAX_RENDER_LENGTH = 200;

const ELLIPSIS = "…";
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";

const renderLabel = (
  label: string,
  colorEnabled: boolean,
  tone: "info" | "success" | "warning" | "error" = "info",
): string => {
  if (!colorEnabled) {
    return label;
  }

  const toneCode =
    tone === "success"
      ? ANSI_GREEN
      : tone === "warning"
        ? ANSI_YELLOW
        : tone === "error"
          ? ANSI_RED
          : ANSI_CYAN;

  return `${ANSI_BOLD}${toneCode}${label}${ANSI_RESET}`;
};

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= ELLIPSIS.length) {
    return ELLIPSIS;
  }

  return `${value.slice(0, maxLength - ELLIPSIS.length)}${ELLIPSIS}`;
};

const describeThrownValue = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return String(error);
  } catch {
    return "[Unprintable error]";
  }
};

const toJsonValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return "[undefined]";
  }

  if (typeof value === "bigint") {
    return `${value}n`;
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry, seen));
  }

  const out: Record<string, unknown> = {};

  for (const key of Reflect.ownKeys(value)) {
    const renderedKey = typeof key === "string" ? key : key.toString();

    try {
      out[renderedKey] = toJsonValue((value as Record<PropertyKey, unknown>)[key], seen);
    } catch (error) {
      out[renderedKey] = `[Thrown ${describeThrownValue(error)}]`;
    }
  }

  const tag = Object.prototype.toString.call(value);
  if (tag !== "[object Object]") {
    out.$type = tag.slice(8, -1);
  }

  return out;
};

export const safeRenderJson = (value: unknown, maxLength = DEFAULT_MAX_RENDER_LENGTH): string => {
  try {
    const rendered = JSON.stringify(toJsonValue(value, new WeakSet<object>()));
    if (rendered !== undefined) {
      return truncate(rendered, maxLength);
    }
  } catch {}

  return truncate(describeThrownValue(value), maxLength);
};

const formatSession = (session: TaskRunSessionIdentity): string =>
  `${session.id} | ${session.branch} from ${session.base}`;

const formatError = (error: unknown, maxLength: number): string => {
  if (error instanceof Error) {
    return truncate(`${error.name}: ${error.message}`, maxLength);
  }

  return safeRenderJson(error, maxLength);
};

export const createNodeTerminalWriters = (
  stdout: Pick<typeof processStdout, "write"> = processStdout,
  stderr: Pick<typeof processStderr, "write"> = processStderr,
): TerminalWriters => ({
  stdout: {
    write(text: string): void {
      stdout.write(text);
    },
  },
  stderr: {
    write(text: string): void {
      stderr.write(text);
    },
  },
});

const resolveColorEnabled = (color: ColorMode, isTty: boolean): boolean => {
  if (color === true || color === false) {
    return color;
  }

  return isTty && process.env.NO_COLOR === undefined;
};

export const createTranscriptRenderer = ({
  task,
  writers = {},
  color = "auto",
  isTty = false,
  maxPayloadLength = DEFAULT_MAX_RENDER_LENGTH,
  terminalWidth = () => processStdout.columns ?? 80,
  spinnerIntervalMs = 120,
  now = Date.now,
}: CreateTranscriptRendererOptions): TranscriptRenderer => {
  const io = {
    ...createNodeTerminalWriters(),
    ...writers,
  } satisfies TerminalWriters;

  const colorEnabled = resolveColorEnabled(color, isTty);
  let lastSession: TaskRunSessionIdentity | undefined;
  type DagStarted = Extract<ConversationEvent, { type: "subagent-progress" }>["progress"] & {
    type: "dag-started";
  };
  type TaskProgress = {
    state: "waiting" | "running" | "completed" | "failed" | "blocked";
    startedAt?: number;
    elapsedMs?: number;
    error?: string;
  };
  let liveDag:
    | {
        definition: DagStarted;
        tasks: Map<string, TaskProgress>;
        lineCount: number;
        frame: number;
        timer?: ReturnType<typeof setInterval>;
        initial: boolean;
        completedElapsedMs?: number;
      }
    | undefined;

  const writeLine = (writer: TerminalWriter, line = ""): void => {
    writer.write(`${line}\n`);
  };

  const writeStatus = (
    label: string,
    value: string,
    tone: "info" | "success" | "warning" | "error" = "info",
  ): void => {
    writeLine(io.stderr, `${renderLabel(label, colorEnabled, tone)}: ${value}`);
  };

  const writeSessionIdentity = (session: TaskRunSessionIdentity): void => {
    writeStatus("Session", formatSession(session));
    if (session.baseWarning) writeStatus("Warning", session.baseWarning, "warning");
  };

  const width = (): number =>
    Math.max(30, typeof terminalWidth === "function" ? terminalWidth() : terminalWidth);
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
  const cleanTerminalText = (value: string): string =>
    [...value.replace(ansiPattern, "")]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127 ? " " : character;
      })
      .join("");
  const elapsed = (milliseconds: number): string =>
    milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
  const fit = (value: string, available: number): string => truncate(value, Math.max(1, available));
  const spinner = ["◐", "◓", "◑", "◒"];

  const dagLines = (): string[] => {
    if (!liveDag) return [];
    const total = liveDag.definition.lanes.reduce((sum, lane) => sum + lane.tasks.length, 0);
    const complete = [...liveDag.tasks.values()].filter((task) =>
      ["completed", "failed", "blocked"].includes(task.state),
    ).length;
    const dagElapsed =
      liveDag.completedElapsedMs ?? Math.max(0, now() - liveDag.definition.startedAt);
    const header = liveDag.initial
      ? `Subagents: Launch DAG · ${total} workers · concurrency ${liveDag.definition.concurrency}`
      : `Subagents: ${complete}/${total} finished · elapsed ${elapsed(dagElapsed)}`;
    const lines = [fit(header, width())];
    for (const lane of liveDag.definition.lanes) {
      const wait = lane.waitsOn.length > 0 ? ` · waits on: ${lane.waitsOn.join(", ")}` : "";
      lines.push(fit(`${lane.id}  ${cleanTerminalText(lane.title)}${wait}`, width()));
      for (const task of lane.tasks) {
        const progress = liveDag.tasks.get(task.id) ?? { state: "waiting" as const };
        const marker =
          progress.state === "completed"
            ? "✓"
            : progress.state === "failed"
              ? "x"
              : progress.state === "blocked"
                ? "x"
                : progress.state === "running"
                  ? spinner[liveDag.frame % spinner.length]
                  : "·";
        const duration =
          progress.state === "running" && progress.startedAt !== undefined
            ? elapsed(Math.max(0, now() - progress.startedAt))
            : progress.elapsedMs !== undefined && progress.state !== "blocked"
              ? elapsed(progress.elapsedMs)
              : "";
        const detail = progress.error ? ` · ${cleanTerminalText(progress.error)}` : "";
        const suffix = duration ? `  ${duration}` : "";
        lines.push(
          fit(`  ${marker} ${task.id} ${cleanTerminalText(task.title)}${detail}${suffix}`, width()),
        );
      }
    }
    return lines;
  };

  const paintDag = (): void => {
    if (!liveDag) return;
    const lines = dagLines();
    if (liveDag.lineCount > 0) io.stderr.write(`\u001b[${liveDag.lineCount}A`);
    for (const line of lines) io.stderr.write(`\r\u001b[2K${line}\n`);
    liveDag.lineCount = lines.length;
    liveDag.initial = false;
  };

  const appendDagEvent = (
    progress: Extract<ConversationEvent, { type: "subagent-progress" }>["progress"],
  ): void => {
    switch (progress.type) {
      case "dag-started": {
        writeStatus(
          "Subagents",
          `Launch DAG · ${progress.lanes.reduce((sum, lane) => sum + lane.tasks.length, 0)} workers · concurrency ${progress.concurrency}`,
        );
        for (const lane of progress.lanes) {
          writeLine(
            io.stderr,
            `${lane.id}  ${cleanTerminalText(lane.title)}${lane.waitsOn.length > 0 ? ` · waits on: ${lane.waitsOn.join(", ")}` : ""}`,
          );
          for (const task of lane.tasks)
            writeLine(io.stderr, `  · ${task.id} ${cleanTerminalText(task.title)}`);
        }
        break;
      }
      case "task-started":
        writeStatus("Subagent", `${progress.id} ${cleanTerminalText(progress.title)}: started`);
        break;
      case "task-completed":
        writeStatus(
          "Subagent",
          `${progress.id} ${cleanTerminalText(progress.title)}: completed in ${elapsed(progress.elapsedMs)}`,
          "success",
        );
        break;
      case "task-failed":
      case "task-blocked":
        writeStatus(
          "Subagent",
          `${progress.id} ${cleanTerminalText(progress.title)}: ${progress.type === "task-failed" ? "failed" : "blocked"}${progress.error ? ` · ${cleanTerminalText(progress.error)}` : ""}`,
          "warning",
        );
        break;
      case "dag-completed":
        writeStatus("Subagents", `DAG complete in ${elapsed(progress.elapsedMs)}`, "success");
        break;
    }
  };

  const renderDagProgress = (
    progress: Extract<ConversationEvent, { type: "subagent-progress" }>["progress"],
  ): void => {
    if (!isTty) {
      appendDagEvent(progress);
      return;
    }
    if (progress.type === "dag-started") {
      liveDag = {
        definition: progress,
        tasks: new Map(
          progress.lanes.flatMap((lane) =>
            lane.tasks.map((task) => [task.id, { state: "waiting" as const }]),
          ),
        ),
        lineCount: 0,
        frame: 0,
        initial: true,
      };
      paintDag();
      liveDag.timer = setInterval(() => {
        if (!liveDag) return;
        liveDag.frame += 1;
        paintDag();
      }, spinnerIntervalMs);
      return;
    }
    if (!liveDag) return;
    if (progress.type === "task-started") {
      liveDag.tasks.set(progress.id, { state: "running", startedAt: progress.startedAt });
    } else if (progress.type === "task-completed") {
      liveDag.tasks.set(progress.id, { state: "completed", elapsedMs: progress.elapsedMs });
    } else if (progress.type === "task-failed" || progress.type === "task-blocked") {
      liveDag.tasks.set(progress.id, {
        state: progress.type === "task-failed" ? "failed" : "blocked",
        elapsedMs: progress.elapsedMs,
        error: progress.error,
      });
    } else if (progress.type === "dag-completed") {
      liveDag.completedElapsedMs = progress.elapsedMs;
      if (liveDag.timer) clearInterval(liveDag.timer);
    }
    paintDag();
    if (progress.type === "dag-completed") liveDag = undefined;
  };

  return {
    renderPrompt(): void {
      writeStatus("Prompt", task);
    },

    renderEvent(event: ConversationEvent): void {
      if ("session" in event) lastSession = event.session;

      switch (event.type) {
        case "sandbox-preparing": {
          writeStatus("Sandbox", event.image);
          if (event.bootstrapCount === 0) {
            writeStatus("Bootstrap", "none configured", "warning");
            writeLine(
              io.stderr,
              'Tip: agentj config add sandbox.bootstrap "<project setup command>"',
            );
          } else {
            writeStatus(
              "Bootstrap",
              `${event.bootstrapCount} command${event.bootstrapCount === 1 ? "" : "s"} configured`,
            );
          }
          break;
        }

        case "sandbox-ready": {
          writeStatus("Bootstrap", "complete", "success");
          break;
        }

        case "sandbox-failed": {
          writeStatus("Sandbox setup failed", event.error, "error");
          break;
        }

        case "local-workspace": {
          writeStatus("Workspace", "local");
          writeStatus("Root", event.root);
          writeStatus("Git", `${event.branch} · ${event.status || "clean"}`);
          break;
        }

        case "project-setup": {
          writeStatus(
            "Project setup",
            `${event.commandCount} command${event.commandCount === 1 ? "" : "s"} complete`,
            "success",
          );
          break;
        }

        case "project-setup-failed": {
          writeStatus("Project setup failed", event.error, "error");
          break;
        }

        case "session-created": {
          writeSessionIdentity(event.session);
          break;
        }

        case "tool-call": {
          writeStatus(
            "Tool",
            `${event.call.name} ${safeRenderJson(event.call.input, maxPayloadLength)}`,
          );
          break;
        }

        case "tool-result": {
          writeStatus(
            event.result.isError ? "Tool error" : "Tool result",
            `${event.result.name} ${safeRenderJson(event.result.output, maxPayloadLength)}`,
            event.result.isError ? "warning" : "info",
          );
          break;
        }

        case "result": {
          writeLine(io.stdout, renderLabel("Result", colorEnabled));
          writeLine(io.stdout, event.result.text);
          break;
        }

        case "commit": {
          writeStatus(
            "Commit",
            event.sha ? `${event.sha} — ${event.message}` : "no changes",
            event.sha ? "success" : "info",
          );
          break;
        }

        case "phase": {
          if (event.phase === "planning") writeStatus("Planning", "investigating request");
          if (event.phase === "building") writeStatus("Build", "approved plan", "success");
          break;
        }

        case "plan": {
          writeLine(
            io.stdout,
            renderLabel(event.revision === 1 ? "Plan" : "Revised plan", colorEnabled),
          );
          writeLine(io.stdout, event.text);
          break;
        }

        case "feedback": {
          writeStatus("Feedback", event.text);
          break;
        }

        case "subagent-progress": {
          renderDagProgress(event.progress);
          break;
        }

        case "build-blocked": {
          writeStatus("Build blocked", event.reason, "warning");
          writeStatus(
            event.session.mode === "local" ? "Workspace" : "Recovery",
            event.session.mode === "local"
              ? "changes remain in local checkout"
              : event.recoveryCommitSha
                ? `${event.recoveryCommitSha} on ${event.session.branch}`
                : `no changes on ${event.session.branch}`,
            "warning",
          );
          break;
        }

        case "local-complete": {
          writeStatus("Workspace", "validated changes left in local checkout", "success");
          break;
        }
      }
    },

    renderOutcome(outcome: ConversationOutcome): void {
      if (liveDag?.timer) clearInterval(liveDag.timer);
      if (liveDag) {
        paintDag();
        liveDag = undefined;
      }
      switch (outcome.kind) {
        case "success": {
          return;
        }

        case "plan-ready": {
          writeStatus("Plan ready", "no changes made; explicit approval is required to build");
          return;
        }

        case "build-blocked": {
          return;
        }

        case "generation-error": {
          writeStatus("Generation failed", formatError(outcome.error, maxPayloadLength), "error");
          break;
        }

        case "commit-error": {
          writeStatus("Commit failed", formatError(outcome.error, maxPayloadLength), "error");
          break;
        }

        case "aborted": {
          writeStatus("Aborted", "generation stopped before commit", "warning");
          break;
        }
      }

      const session = outcome.session ?? lastSession;
      if (session) {
        writeStatus("Last known session", `${formatSession(session)} @ ${session.path}`);
      }
    },
  };
};
