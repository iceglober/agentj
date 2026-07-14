import { createRequire } from "node:module";
import { stderr as processStderr, stdout as processStdout } from "node:process";
import type { Readable, Writable } from "node:stream";

import type { TaskRunEvent, TaskRunOutcome, TaskRunSessionIdentity } from "../app/run";

type PromptQuestion<T extends string = string> = import("prompts").PromptObject<T>;
type PromptAnswers<T extends string = string> = import("prompts").Answers<T>;
type PromptOptions = import("prompts").Options;

export type PromptRunner = <T extends string = string>(
  questions: PromptQuestion<T> | PromptQuestion<T>[],
  options?: PromptOptions,
) => Promise<PromptAnswers<T>>;

export interface PromptUi {
  askTask(options?: PromptIo): Promise<string | null>;
}

export interface PromptIo {
  stdin?: Readable;
  stdout?: Writable;
}

export type InteractiveInputGate = boolean | ((stdin?: Readable) => boolean);

export interface CreatePromptsPromptUiOptions extends PromptIo {
  prompts?: PromptRunner;
  isInteractive?: InteractiveInputGate;
}

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
  renderEvent(event: TaskRunEvent): void;
  renderOutcome(outcome: TaskRunOutcome): void;
}

export interface CreateTranscriptRendererOptions {
  task: string;
  writers?: Partial<TerminalWriters>;
  color?: ColorMode;
  isTty?: boolean;
  maxPayloadLength?: number;
}

export const DEFAULT_MAX_RENDER_LENGTH = 200;

const ELLIPSIS = "…";
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";

const require = createRequire(import.meta.url);
const prompts = require("prompts") as PromptRunner;

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

const normalizeTask = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPromptInputClosed = (stdin?: Readable): boolean => {
  return stdin?.destroyed === true || stdin?.readableEnded === true;
};

const resolveInteractiveInput = (
  gate: InteractiveInputGate | undefined,
  stdin?: Readable,
): boolean => {
  if (isPromptInputClosed(stdin)) {
    return false;
  }

  if (typeof gate === "function") {
    return gate(stdin);
  }

  return gate ?? true;
};

export const createPromptsPromptUi = (options: CreatePromptsPromptUiOptions = {}): PromptUi => {
  const promptRunner = options.prompts ?? prompts;

  return {
    async askTask(override = {}) {
      const stdin = override.stdin ?? options.stdin;

      if (!resolveInteractiveInput(options.isInteractive, stdin)) {
        return null;
      }

      let cancelled = false;

      const question: PromptQuestion<"task"> = {
        type: "text",
        name: "task",
        message:
          "AgentJ runs one task, then exits. What should it do?\nExamples: fix a failing test; explain a module boundary; add a targeted regression test.",
        hint: "Describe one coding task.",
        stdin,
        stdout: override.stdout ?? options.stdout,
        validate: (value) =>
          normalizeTask(value) !== null || "Enter a task, or press Ctrl+C to cancel.",
      };

      const answers = await promptRunner<"task">(question, {
        onCancel: () => {
          cancelled = true;
        },
      });

      if (cancelled) {
        return null;
      }

      return normalizeTask(answers.task);
    },
  };
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
}: CreateTranscriptRendererOptions): TranscriptRenderer => {
  const io = {
    ...createNodeTerminalWriters(),
    ...writers,
  } satisfies TerminalWriters;

  const colorEnabled = resolveColorEnabled(color, isTty);
  let lastSession: TaskRunSessionIdentity | undefined;

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
  };

  return {
    renderPrompt(): void {
      writeStatus("Prompt", task);
    },

    renderEvent(event: TaskRunEvent): void {
      lastSession = event.session;

      switch (event.type) {
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
      }
    },

    renderOutcome(outcome: TaskRunOutcome): void {
      switch (outcome.kind) {
        case "success": {
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
