import { createAgent as createProductionAgent, type Agent } from "../agent";
import { loadConfig } from "../config";
import type { RunResult, RunStep } from "../llm";
import type { PromptContext } from "../prompt";
import { getSandbox, type Sandbox } from "../sandbox";
import {
  createSandboxProviderMicrosandbox,
  resolveProjectSource,
  type ProjectSource,
} from "../sandbox/microsandbox-adapter";
import {
  createChildSession,
  createSession,
  type Session,
} from "../session";

const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 2;

type ToolCall = RunStep["toolCalls"][number];
type ToolResult = RunStep["toolResults"][number];

export interface TaskRunSessionIdentity {
  id: string;
  branch: string;
  base: string;
  path: string;
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

const safeChildIdSegment = (value: string): string => {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || "task";
};

const summarizeStatus = (porcelain: string): string => {
  const count = porcelain.split("\n").filter(Boolean).length;
  return count === 0 ? "clean" : `${count} files changed`;
};

const toSessionIdentity = (session: Session): TaskRunSessionIdentity => ({
  id: session.id,
  branch: session.branch,
  base: session.base,
  path: session.path,
});

const buildCommitMessage = (task: string): string =>
  `agentj: ${task.slice(0, 72)}`;

const disposeAsync = async (value: unknown): Promise<void> => {
  if (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncDispose in value &&
    typeof value[Symbol.asyncDispose] === "function"
  ) {
    await (value as { [Symbol.asyncDispose]: () => Promise<void> })[
      Symbol.asyncDispose
    ]();
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
          if (!shouldIncludeToolResult(toolResult)) {
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

export interface ProductionTaskRunDependencyOverrides {
  /** Launch directory used as the session's host Git source. */
  projectDir?: string;
  /** Test seam for project preflight; production resolves through the adapter. */
  resolveProjectSource?: (projectDir: string) => Promise<ProjectSource>;
  /** Test seam for sandbox provisioning after launch-project preparation. */
  createSandbox?: (
    options: Parameters<typeof createSandboxProviderMicrosandbox>[0],
  ) => Promise<Sandbox>;
  /** Test seam for parent session construction. */
  createSession?: typeof createSession;
  /** Test seam for delegated child-session construction. */
  createChildSession?: typeof createChildSession;
  /** Test seam for agent construction. */
  createAgent?: typeof createProductionAgent;
}

export async function createProductionTaskRunDependencies(
  configPath: string = new URL("../../agentj.json", import.meta.url).pathname,
  overrides: ProductionTaskRunDependencyOverrides = {},
): Promise<TaskRunDependencies> {
  const config = await loadConfig(configPath);
  const childSessionIds = new Set<string>();
  let childSessionCounter = 0;
  let preparation: Promise<ProjectSource | undefined> | undefined;

  const prepareProjectSource = (): Promise<ProjectSource | undefined> =>
    (preparation ??= (async () => {
      if (!overrides.projectDir) return undefined;

      try {
        return await (overrides.resolveProjectSource ?? resolveProjectSource)(
          overrides.projectDir,
        );
      } catch {
        throw new Error("Unable to prepare the launch project.");
      }
    })());

  const sessionConfig = async () => {
    const projectSource = await prepareProjectSource();
    return {
      ...config.session,
      ...(projectSource ? { repoDir: projectSource.projectRoot } : {}),
    };
  };

  const nextChildSessionId = (taskId: string): string => {
    const stem = safeChildIdSegment(taskId);

    while (true) {
      childSessionCounter += 1;
      const candidate = `subagent-${childSessionCounter.toString().padStart(4, "0")}-${stem}`;
      if (childSessionIds.has(candidate)) {
        continue;
      }

      childSessionIds.add(candidate);
      return candidate;
    }
  };

  const createPromptContext = async (
    sandbox: Sandbox,
    session: Session,
  ): Promise<PromptContext> => ({
    cwd: session.path,
    os: (await sandbox.executeCommand("uname -sr")).stdout.trim(),
    date: new Date().toISOString().slice(0, 10),
    gitBranch: session.branch,
    gitStatusSummary: summarizeStatus(await session.status()),
  });

  return {
    createSandbox: async () => {
      const projectSource = await prepareProjectSource();
      const sandboxOptions = {
        ...config.sandbox,
        ...(projectSource ? { projectSource } : {}),
      };
      return overrides.createSandbox
        ? overrides.createSandbox(sandboxOptions)
        : getSandbox(createSandboxProviderMicrosandbox(sandboxOptions));
    },
    createSession: async (sandbox) =>
      (overrides.createSession ?? createSession)(sandbox, await sessionConfig()),
    createAgent: async ({ sandbox, session }) => {
      let agentsMd = "";
      try {
        agentsMd = await sandbox.readFile(`${session.path}/AGENTS.md`);
      } catch {}

      const rules = config.agent.rules || agentsMd || "";

      return (overrides.createAgent ?? createProductionAgent)(
        sandbox,
        { ...config.agent, rules },
        {
          root: session.path,
          ctx: await createPromptContext(sandbox, session),
          delegation: {
            parentRef: session.branch,
            maxConcurrency: DEFAULT_SUBAGENT_MAX_CONCURRENCY,
            createChildSession: async ({ id, parentRef }) =>
              (overrides.createChildSession ?? createChildSession)(sandbox, await sessionConfig(), {
                id: nextChildSessionId(id),
                parentRef,
              }),
          },
        },
      );
    },
  };
}
