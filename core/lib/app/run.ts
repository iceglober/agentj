import { createAgent as createProductionAgent, type Agent } from "../agent";
import { loadConfig } from "../config";
import { createOtelMetricsSink } from "../metrics/otel-adapter";
import type { MetricsSink } from "../metrics";
import { resolveAzureApiKey, type SecretStore } from "../secrets";
import { createKeyringSecretStore } from "../secrets/keyring-adapter";
import type { RunResult, RunStep } from "../llm";
import type { PromptContext } from "../prompt";
import { getSandbox, type Sandbox } from "../sandbox";
import { createSandboxProviderMicrosandbox } from "../sandbox/microsandbox-adapter";
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

/**
 * Optional test seams for production task-run wiring. Overrides are used only
 * to construct dependencies; they are never emitted as task events or outcomes.
 */
export interface ProductionTaskRunDependencyOverrides {
  config?: Awaited<ReturnType<typeof loadConfig>>;
  loadConfig?: typeof loadConfig;
  env?: Record<string, string | undefined>;
  secretStore?: SecretStore;
  metricsSink?: MetricsSink;
  createMetricsSink?: (options: { enabled: boolean }) => MetricsSink;
  createSandbox?: TaskRunDependencies["createSandbox"];
  createSession?: TaskRunDependencies["createSession"];
  createAgent?: typeof createProductionAgent;
  onAgentCreate?: () => void | Promise<void>;
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

export async function createProductionTaskRunDependencies(
  configPath: string = new URL("../../agentj.json", import.meta.url).pathname,
  overrides: ProductionTaskRunDependencyOverrides = {},
): Promise<TaskRunDependencies> {
  const env = overrides.env ?? process.env;
  let preparation: Promise<{
    config: Awaited<ReturnType<typeof loadConfig>>;
    azureApiKey: string;
    metricsSink: MetricsSink;
  }> | undefined;
  const prepare = () =>
    (preparation ??= (async () => {
      const config =
        overrides.config ??
        (await (overrides.loadConfig ?? loadConfig)(configPath));
      const azureApiKey = await resolveAzureApiKey({
        env,
        store: overrides.secretStore ?? createKeyringSecretStore({}),
      });
      if (azureApiKey.status === "missing") {
        throw new Error(
          "Azure API key missing; run agentj:secrets ... or set env",
        );
      }
      if (azureApiKey.status === "store-unavailable") {
        throw new Error(
          "Secure secret store unavailable; set AZURE_FOUNDRY_API_KEY/AZURE_API_KEY for automation or configure the OS keychain.",
        );
      }

      return {
        config,
        azureApiKey: azureApiKey.apiKey,
        metricsSink:
          overrides.metricsSink ??
          (overrides.createMetricsSink ?? createOtelMetricsSink)({
            enabled: env.AGENTJ_OTEL_METRICS === "1",
          }),
      };
    })());
  const childSessionIds = new Set<string>();
  let childSessionCounter = 0;

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
      const { config } = await prepare();
      return overrides.createSandbox
        ? overrides.createSandbox()
        : getSandbox(createSandboxProviderMicrosandbox(config.sandbox));
    },
    createSession: async (sandbox) => {
      const { config } = await prepare();
      return overrides.createSession
        ? overrides.createSession(sandbox)
        : createSession(sandbox, config.session);
    },
    createAgent: async ({ sandbox, session }) => {
      const { azureApiKey, config, metricsSink } = await prepare();
      let agentsMd = "";
      try {
        agentsMd = await sandbox.readFile(`${session.path}/AGENTS.md`);
      } catch {}

      const rules = config.agent.rules || agentsMd || "";

      await overrides.onAgentCreate?.();
      return (overrides.createAgent ?? createProductionAgent)(
        sandbox,
        {
          ...config.agent,
          rules,
          llm: {
            ...config.agent.llm,
            providers: {
              ...config.agent.llm.providers,
              azure: {
                ...config.agent.llm.providers?.azure,
                apiKey: azureApiKey,
              },
            },
          },
        },
        {
          root: session.path,
          ctx: await createPromptContext(sandbox, session),
          metricsSink,
          delegation: {
            parentRef: session.branch,
            maxConcurrency: DEFAULT_SUBAGENT_MAX_CONCURRENCY,
            createChildSession: ({ id, parentRef }) =>
              createChildSession(sandbox, config.session, {
                id: nextChildSessionId(id),
                parentRef,
              }),
          },
        },
      );
    },
  };
}
