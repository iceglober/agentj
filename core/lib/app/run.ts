import type { Agent } from "../agent";
import type { RunResult, RunStep } from "../llm";
import type { Sandbox } from "../sandbox";
import type { Session } from "../session";

type ToolCall = RunStep["toolCalls"][number];
type ToolResult = RunStep["toolResults"][number];

export interface TaskRunSessionIdentity {
  id: string;
  branch: string;
  base: string;
  path: string;
  baseWarning?: string;
  mode?: "local" | "sandbox";
}

export type TaskRunEvent =
  | {
      type: "session-created";
      session: TaskRunSessionIdentity;
    }
  | {
      type: "tool-call";
      session: TaskRunSessionIdentity;
      call: ToolCall;
    }
  | {
      type: "tool-result";
      session: TaskRunSessionIdentity;
      result: ToolResult;
    }
  | {
      type: "result";
      session: TaskRunSessionIdentity;
      result: RunResult;
    }
  | {
      type: "commit";
      session: TaskRunSessionIdentity;
      result: RunResult;
      message: string;
      sha: string | null;
    };

export type TaskRunOutcome =
  | {
      kind: "success";
      session: TaskRunSessionIdentity;
      result: RunResult;
      commitSha: string | null;
    }
  | {
      kind: "generation-error";
      session?: TaskRunSessionIdentity;
      error: unknown;
    }
  | {
      kind: "commit-error";
      session: TaskRunSessionIdentity;
      result: RunResult;
      error: unknown;
    }
  | {
      kind: "aborted";
      session?: TaskRunSessionIdentity;
      error: unknown;
    };

export interface TaskRunDependencies {
  createSandbox(): Promise<Sandbox>;
  createSession(sandbox: Sandbox): Promise<Session>;
  createAgent(args: { sandbox: Sandbox; session: Session }): Promise<Agent>;
  shouldIncludeToolResult?(toolResult: ToolResult): boolean;
}

export interface RunAgentTaskOptions {
  signal: AbortSignal;
  onEvent?: (event: TaskRunEvent) => void | Promise<void>;
  dependencies: TaskRunDependencies;
}

const defaultShouldIncludeToolResult = (toolResult: ToolResult): boolean =>
  toolResult.name === "run_subagents";

const toSessionIdentity = (session: Session): TaskRunSessionIdentity => ({
  id: session.id,
  branch: session.branch,
  base: session.base,
  path: session.path,
  ...(session.baseWarning ? { baseWarning: session.baseWarning } : {}),
  ...(session.mode ? { mode: session.mode } : {}),
});

const buildCommitMessage = (task: string): string => `agentj: ${task.slice(0, 72)}`;

const disposeAsync = async (value: unknown): Promise<void> => {
  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncDispose in value &&
    typeof value[Symbol.asyncDispose] === "function"
  ) {
    await (value as { [Symbol.asyncDispose]: () => Promise<void> })[Symbol.asyncDispose]();
    return;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof value.dispose === "function"
  ) {
    await (value as { dispose: () => Promise<void> }).dispose();
  }
};

const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError";
};

export async function runAgentTask(
  task: string,
  { signal, onEvent, dependencies }: RunAgentTaskOptions,
): Promise<TaskRunOutcome> {
  const emit = async (event: TaskRunEvent): Promise<void> => {
    await onEvent?.(event);
  };

  const captureErrorOutcome = (error: unknown): TaskRunOutcome => {
    if (result) {
      return {
        kind: "commit-error",
        session: sessionIdentity!,
        result,
        error,
      };
    }

    if (signal.aborted || isAbortError(error)) {
      return {
        kind: "aborted",
        session: sessionIdentity,
        error,
      };
    }

    return {
      kind: "generation-error",
      session: sessionIdentity,
      error,
    };
  };

  let sandbox: Sandbox | undefined;
  let session: Session | undefined;
  let sessionIdentity: TaskRunSessionIdentity | undefined;
  let result: RunResult | undefined;
  let outcome: TaskRunOutcome | undefined;
  let disposalError: unknown;

  try {
    sandbox = await dependencies.createSandbox();
    session = await dependencies.createSession(sandbox);
    sessionIdentity = toSessionIdentity(session);
    const currentSession = sessionIdentity;

    await emit({ type: "session-created", session: currentSession });

    const agent = await dependencies.createAgent({ sandbox, session });
    const shouldIncludeToolResult =
      dependencies.shouldIncludeToolResult ?? defaultShouldIncludeToolResult;

    result = await agent.generate(task, {
      abortSignal: signal,
      onStep: async (step) => {
        for (const call of step.toolCalls) {
          await emit({
            type: "tool-call",
            session: currentSession,
            call,
          });
        }

        for (const toolResult of step.toolResults) {
          if (!toolResult.isError && !shouldIncludeToolResult(toolResult)) {
            continue;
          }

          await emit({
            type: "tool-result",
            session: currentSession,
            result: toolResult,
          });
        }
      },
    });

    await emit({ type: "result", session: currentSession, result });

    const message = buildCommitMessage(task);
    const commitSha = await session.commitAll(message);

    await emit({
      type: "commit",
      session: currentSession,
      result,
      message,
      sha: commitSha,
    });

    outcome = {
      kind: "success",
      session: currentSession,
      result,
      commitSha,
    };
  } catch (error) {
    outcome = captureErrorOutcome(error);
  }

  if (session) {
    try {
      await disposeAsync(session);
    } catch (error) {
      disposalError ??= error;
    }
  }

  if (sandbox) {
    try {
      await disposeAsync(sandbox);
    } catch (error) {
      disposalError ??= error;
    }
  }

  if (disposalError !== undefined) {
    if (outcome && outcome.kind !== "success") {
      return outcome;
    }

    return captureErrorOutcome(disposalError);
  }

  return outcome!;
}
