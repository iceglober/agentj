import { stderr as processStderr, stdout as processStdout } from "node:process";

import { command, optional, positional, runSafely, string } from "cmd-ts";

import type { TaskRunEvent, TaskRunOutcome } from "../app/run";
import type { PromptUi, TranscriptRenderer } from "../tui";

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ABORTED = 130;

export const DEFAULT_COMMAND_NAME = "agentj";
export const DEFAULT_COMMAND_DESCRIPTION =
  "Run one AgentJ task from the terminal.";

export interface AgentjTaskRunnerOptions {
  signal: AbortSignal;
  onEvent?: (event: TaskRunEvent) => void | Promise<void>;
}

export interface AgentjTaskRunner {
  (
    task: string,
    options: AgentjTaskRunnerOptions,
  ): Promise<TaskRunOutcome>;
}

export interface AgentjCommandDependencies {
  version: string;
  promptUi: PromptUi;
  createRenderer(task: string): TranscriptRenderer;
  runTask: AgentjTaskRunner;
  createAbortSignal?: () => AbortSignal;
  name?: string;
  description?: string;
}

export interface AgentjCliIo {
  stdout?: Pick<typeof processStdout, "write">;
  stderr?: Pick<typeof processStderr, "write">;
}

const normalizeTask = (value: string | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toExitCode = (outcome: TaskRunOutcome): number => {
  switch (outcome.kind) {
    case "success": {
      return EXIT_SUCCESS;
    }

    case "aborted": {
      return EXIT_ABORTED;
    }

    case "generation-error":
    case "commit-error": {
      return EXIT_FAILURE;
    }
  }
};

export const createAgentjCommand = ({
  version,
  promptUi,
  createRenderer,
  runTask,
  createAbortSignal = () => new AbortController().signal,
  name = DEFAULT_COMMAND_NAME,
  description = DEFAULT_COMMAND_DESCRIPTION,
}: AgentjCommandDependencies) =>
  command({
    name,
    version,
    description,
    args: {
      task: positional({
        type: optional(string),
        description: "Task to run. If omitted, AgentJ asks once.",
      }),
    },
    async handler({ task }): Promise<number> {
      const resolvedTask = normalizeTask(task) ?? (await promptUi.askTask());
      const normalizedTask = normalizeTask(resolvedTask ?? undefined);

      if (normalizedTask === null) {
        return EXIT_SUCCESS;
      }

      const renderer = createRenderer(normalizedTask);
      renderer.renderPrompt();

      const outcome = await runTask(normalizedTask, {
        signal: createAbortSignal(),
        onEvent(event) {
          renderer.renderEvent(event);
        },
      });

      renderer.renderOutcome(outcome);
      return toExitCode(outcome);
    },
  });

export async function runAgentjCli(
  argv: string[],
  deps: AgentjCommandDependencies,
  io: AgentjCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? processStdout;
  const stderr = io.stderr ?? processStderr;
  const result = await runSafely(createAgentjCommand(deps), argv);

  if (result._tag === "error") {
    const { exitCode, into, message } = result.error.config;
    (into === "stdout" ? stdout : stderr).write(message);
    return exitCode;
  }

  return await Promise.resolve(result.value);
}
