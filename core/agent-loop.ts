import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stderr as processStderr, stdout as processStdout } from "node:process";

import { type Agent, createAgent as createProductionAgent } from "./lib/agent";
import type { CreatePlanningDagToolOptions } from "./lib/agent/planning-delegate";
import { createSubagentsTool, type SubagentProgressEvent } from "./lib/agent/subagents";
import type { ConversationDependencies } from "./lib/app/conversation";
import { runAgentConversation } from "./lib/app/conversation";
import {
  type ChatCommandContext,
  expandAtFiles,
  parseInput,
  runChatCommand,
} from "./lib/chat/commands";
import type { ChatEvent } from "./lib/chat/events";
import { createJobRunner } from "./lib/chat/jobs";
import { createChatSession } from "./lib/chat/session";
import { type AgentjTaskRunnerOptions, runAgentjCli } from "./lib/cli";
import { loadConfig } from "./lib/config";
import { createConfigCliHandlers, createMaskedSecretPrompt } from "./lib/config-cli";
import { createEvalCliHandlers, type EvalCliHandlers } from "./lib/eval-cli";
import type { MetricsSink } from "./lib/metrics";
import { createOtelMetricsSink } from "./lib/metrics/otel-adapter";
import type { PromptContext } from "./lib/prompt";
import { getSandbox, type Sandbox } from "./lib/sandbox";
import { type ProjectSource, resolveProjectSource } from "./lib/sandbox/microsandbox-adapter";
import { type SandboxProviderName, sandboxAdapters } from "./lib/sandbox/registry";
import { resolveAzureApiKey, type SecretStore } from "./lib/secrets";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";
import { createChildSession, createLocalSession, createSession, type Session } from "./lib/session";
import { createChatLog } from "./lib/session/log";
import { createUndoStack } from "./lib/session/undo";
import type { StoredAgentSession } from "./lib/session-store";
import { createFileSessionStore } from "./lib/session-store/file-adapter";
import {
  createNodeTerminalWriters,
  createPromptUi,
  createTerminalPromptEditor,
  createTranscriptRenderer,
} from "./lib/tui";
import { createChatScreen } from "./lib/tui/chat-screen";
import { createProgressTracker } from "./lib/tui/progress";
import {
  createGitDelegationSnapshot,
  integrateGitDelegation,
} from "./lib/workspace/git-integration";
import { createHostExecutionEnvironment } from "./lib/workspace/host-adapter";
import { resolveProjectSource as resolveHostProjectSource } from "./lib/workspace/project-source";

const COMMAND_VERSION = "0.0.0";

export interface ProductionDependencyOverrides {
  workspaceMode?: "local" | "sandbox";
  sessionId?: string;
  projectDir?: string;
  resolveProjectSource?: (projectDir: string) => Promise<ProjectSource>;
  config?: Awaited<ReturnType<typeof loadConfig>>;
  loadConfig?: typeof loadConfig;
  env?: Record<string, string | undefined>;
  secretStore?: SecretStore;
  metricsSink?: MetricsSink;
  createMetricsSink?: (options: { enabled: boolean }) => MetricsSink;
  createSandbox?: (
    options: Parameters<(typeof sandboxAdapters)["microsandbox"]["create"]>[0],
  ) => Promise<Sandbox>;
  sandboxProvider?: SandboxProviderName;
  createSession?: typeof createSession;
  createChildSession?: typeof createChildSession;
  createAgent?: typeof createProductionAgent;
  onAgentCreate?: () => void | Promise<void>;
}

const safeChildIdSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";

const summarizeStatus = (porcelain: string): string => {
  const count = porcelain.split("\n").filter(Boolean).length;
  return count === 0 ? "clean" : `${count} files changed`;
};

export function createProductionEvalCliHandlers(): EvalCliHandlers {
  const spawn = async (script: string, args: string[] = []): Promise<number> => {
    const child = Bun.spawn({
      cmd: [process.execPath, script, ...args],
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  };
  return createEvalCliHandlers({
    run: () => spawn("core/eval/run.ts"),
    report: () => spawn("core/eval/report.ts"),
    selfcheck: () => spawn("core/eval/run.ts", ["--selfcheck"]),
  });
}

/**
 * The sole production composition root. Domain modules expose ports and pure
 * factories; concrete adapters are selected and connected only from this entrypoint.
 */
export async function createProductionTaskRunDependencies(
  configPath: string = new URL("./agentj.json", import.meta.url).pathname,
  overrides: ProductionDependencyOverrides = {},
): Promise<ConversationDependencies> {
  const workspaceMode = overrides.workspaceMode ?? "sandbox";
  const env = overrides.env ?? process.env;
  let preparation:
    | Promise<{
        config: Awaited<ReturnType<typeof loadConfig>>;
        azureApiKey: string;
        metricsSink: MetricsSink;
        projectSource: ProjectSource | undefined;
      }>
    | undefined;
  const prepare = () =>
    (preparation ??= (async () => {
      let projectSource: ProjectSource | undefined;
      if (overrides.projectDir) {
        try {
          projectSource = await (overrides.resolveProjectSource ?? resolveProjectSource)(
            overrides.projectDir,
          );
        } catch {
          throw new Error("Unable to prepare the launch project.");
        }
      }
      const config = overrides.config ?? (await (overrides.loadConfig ?? loadConfig)(configPath));
      const key = await resolveAzureApiKey({
        env,
        store: overrides.secretStore ?? createKeyringSecretStore({}),
      });
      if (key.status === "missing") {
        throw new Error(
          "Azure API key missing; run: agentj config set --secret providers.azure.api_key",
        );
      }
      if (key.status === "store-unavailable") {
        throw new Error(
          "Secure secret store unavailable; set AZURE_FOUNDRY_API_KEY/AZURE_API_KEY for automation or configure the OS keychain.",
        );
      }
      return {
        config,
        azureApiKey: key.apiKey,
        metricsSink:
          overrides.metricsSink ??
          (overrides.createMetricsSink ?? createOtelMetricsSink)({
            enabled: env.AGENTJ_OTEL_METRICS === "1",
          }),
        projectSource,
      };
    })());

  const childIds = new Set<string>();
  let childCounter = 0;
  const nextChildId = (taskId: string): string => {
    while (true) {
      childCounter += 1;
      const id = `subagent-${childCounter.toString().padStart(4, "0")}-${safeChildIdSegment(taskId)}`;
      if (!childIds.has(id)) {
        childIds.add(id);
        return id;
      }
    }
  };
  const resolvedSessionConfig = async () => {
    const { config, projectSource } = await prepare();
    return {
      ...config.session,
      ...(projectSource ? { repoDir: projectSource.projectRoot } : {}),
      ...(workspaceMode === "local" ? { root: join(tmpdir(), "agentj-worktrees") } : {}),
    };
  };
  const promptContext = async (sandbox: Sandbox, session: Session): Promise<PromptContext> => ({
    cwd: session.path,
    os: (await sandbox.executeCommand("uname -sr")).stdout.trim(),
    date: new Date().toISOString().slice(0, 10),
    gitBranch: session.branch,
    gitStatusSummary: summarizeStatus(await session.status()),
  });

  const createConfiguredAgent = async (
    sandbox: Sandbox,
    session: Session,
    purpose: "planner" | "planning-worker" | "builder" = "builder",
    onPlanningProgress?: CreatePlanningDagToolOptions["onProgress"],
  ): Promise<Agent> => {
    const { azureApiKey, config, metricsSink } = await prepare();
    let agentsMd = "";
    try {
      agentsMd = await sandbox.readFile(`${session.path}/AGENTS.md`);
    } catch {}
    // Tier routing: planning workers run the configured subagent model (build
    // subagents get theirs inside the run_subagents tool via childAgentConfig).
    const routedModel =
      purpose === "planning-worker"
        ? (config.agent.tools.subagents.model ?? config.agent.llm.model)
        : config.agent.llm.model;
    const agentConfig = {
      ...config.agent,
      rules: config.agent.rules || agentsMd || "",
      llm: {
        ...config.agent.llm,
        model: routedModel,
        providers: {
          ...config.agent.llm.providers,
          azure: { ...config.agent.llm.providers?.azure, apiKey: azureApiKey },
        },
      },
    };
    await overrides.onAgentCreate?.();
    return (overrides.createAgent ?? createProductionAgent)(sandbox, agentConfig, {
      root: session.path,
      ctx: await promptContext(sandbox, session),
      metricsSink,
      purpose,
      ...(purpose === "planner"
        ? {
            planning: {
              createWorker: async () => createConfiguredAgent(sandbox, session, "planning-worker"),
              onProgress: onPlanningProgress,
            },
          }
        : {}),
      ...(purpose === "builder"
        ? {
            delegation: {
              parentRef: session.branch,
              maxConcurrency: config.agent.tools.subagents.concurrency,
              createChildSession: async ({ id, parentRef }) =>
                (overrides.createChildSession ?? createChildSession)(
                  sandbox,
                  await resolvedSessionConfig(),
                  { id: nextChildId(id), parentRef },
                ),
              prepareBatch: async () => {
                const sessionConfig = await resolvedSessionConfig();
                const snapshot = await createGitDelegationSnapshot(
                  sandbox,
                  session.path,
                  session.id,
                );
                return {
                  parentRef: snapshot.commit,
                  createChildSession: async ({ id, parentRef }) =>
                    (overrides.createChildSession ?? createChildSession)(sandbox, sessionConfig, {
                      id: nextChildId(`${snapshot.id.slice(0, 8)}-${id}`),
                      parentRef,
                    }),
                  integrate: (results) =>
                    integrateGitDelegation(sandbox, session.path, session.id, snapshot, results),
                };
              },
            },
          }
        : {}),
    });
  };

  return {
    ...(workspaceMode === "sandbox"
      ? {
          describeSandbox: async () => {
            const { config } = await prepare();
            return {
              image: config.sandbox.image,
              bootstrapCount: config.sandbox.bootstrap.length,
            };
          },
        }
      : {}),
    createSandbox: async () => {
      const { config, projectSource } = await prepare();
      if (workspaceMode === "local") {
        if (!projectSource) throw new Error("Local workspace requires a launch project.");
        return createHostExecutionEnvironment(projectSource.projectRoot);
      }
      const options = { ...config.sandbox, ...(projectSource ? { projectSource } : {}) };
      return overrides.createSandbox
        ? overrides.createSandbox(options)
        : getSandbox(() =>
            sandboxAdapters[overrides.sandboxProvider ?? "microsandbox"].create(options),
          );
    },
    createSession: async (sandbox) => {
      if (workspaceMode === "local") {
        const { projectSource } = await prepare();
        if (!projectSource) throw new Error("Local workspace requires a launch project.");
        return createLocalSession(sandbox, projectSource.projectRoot, overrides.sessionId);
      }
      return (overrides.createSession ?? createSession)(
        sandbox,
        await resolvedSessionConfig(),
        overrides.sessionId,
      );
    },
    setupWorkspace: async (sandbox, session) => {
      const { config } = await prepare();
      for (const [index, command] of config.project.setup.entries()) {
        const result = await sandbox.executeCommand(
          `cd ${JSON.stringify(session.path)} && ${command}`,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `Project setup command ${index + 1} failed with exit code ${result.exitCode}.`,
          );
        }
      }
      return config.project.setup.length;
    },
    createAgent: async (args) =>
      createConfiguredAgent(
        args.sandbox,
        args.session,
        "purpose" in args ? args.purpose : "builder",
        "onPlanningProgress" in args ? args.onPlanningProgress : undefined,
      ),
  };
}

const formatUnexpectedError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv[0] === "chat") {
    process.exitCode = await runAgentjChat();
    return;
  }
  const abortController = new AbortController();
  const promptUi = createPromptUi({
    editor: createTerminalPromptEditor(),
    stdin: process.stdin,
    stdout: processStdout,
    isInteractive: Boolean(process.stdin.isTTY),
  });
  const writers = createNodeTerminalWriters(processStdout, processStderr);
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const sessionStore = createFileSessionStore(join(stateRoot, "agentj", "sessions"));
  const configHandlers = createConfigCliHandlers({
    secretStore: createKeyringSecretStore({}),
    prompt: createMaskedSecretPrompt(),
    writers,
  });
  let evalHandlers: ReturnType<typeof createProductionEvalCliHandlers> | undefined;
  const runStoredSession = async (
    task: string,
    workspaceMode: "local" | "sandbox",
    options: AgentjTaskRunnerOptions,
    existing?: StoredAgentSession,
    sandboxProvider?: SandboxProviderName,
  ) => {
    const now = new Date().toISOString();
    let stored: StoredAgentSession = existing ?? {
      id: crypto.randomUUID().slice(0, 8),
      version: 1,
      projectRoot: process.cwd(),
      workspaceMode,
      ...(sandboxProvider ? { sandboxProvider } : {}),
      task,
      phase: "preparing",
      plan: null,
      planRevision: 0,
      feedback: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!existing) await sessionStore.create(stored);
    let recoveryFeedback: string[] = [];
    if (existing) {
      const process = Bun.spawn({
        cmd: [
          "git",
          "-C",
          stored.projectRoot,
          "for-each-ref",
          `refs/agentj/sessions/${stored.id}`,
          "--format=%(refname) %(objectname)",
        ],
        stdout: "pipe",
        stderr: "ignore",
      });
      const [exitCode, output] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      if (exitCode === 0 && output.trim()) {
        recoveryFeedback = [
          `Resume observed durable delegation refs:\n${output.trim()}\nInspect and reconcile these automatically before finishing.`,
        ];
      }
    }
    const dependencies = await createProductionTaskRunDependencies(undefined, {
      projectDir: stored.projectRoot,
      workspaceMode: stored.workspaceMode,
      ...(stored.workspaceMode === "local" ? { sessionId: stored.id } : {}),
      ...(stored.workspaceMode === "sandbox" && stored.sandboxProvider
        ? { sandboxProvider: stored.sandboxProvider as SandboxProviderName }
        : {}),
    });
    const save = async (changes: Partial<StoredAgentSession>) => {
      stored = {
        ...stored,
        ...changes,
        version: stored.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await sessionStore.save(stored);
    };
    const outcome = await runAgentConversation(task, {
      ...options,
      dependencies,
      ...(stored.plan
        ? {
            initialState: {
              plan: stored.plan,
              revision: stored.planRevision,
              feedback: [...stored.feedback, ...recoveryFeedback],
              resumeBuilding: stored.phase === "building" || stored.phase === "blocked",
            },
          }
        : {}),
      async onEvent(event) {
        if (event.type === "phase") await save({ phase: event.phase });
        if (event.type === "plan") {
          await save({ plan: event.text, planRevision: event.revision });
        }
        if (event.type === "feedback") {
          await save({ feedback: [...stored.feedback, event.text] });
        }
        await options.onEvent?.(event);
      },
    });
    await save({
      phase:
        outcome.kind === "success"
          ? "completed"
          : outcome.kind === "aborted"
            ? "aborted"
            : outcome.kind === "plan-ready"
              ? "awaiting-feedback"
              : "blocked",
    });
    return outcome;
  };

  const handleSigint = (): void => {
    abortController.abort();
  };

  process.once("SIGINT", handleSigint);

  try {
    const exitCode = await runAgentjCli(
      argv,
      {
        version: COMMAND_VERSION,
        configHandlers,
        createEvalHandlers: () => (evalHandlers ??= createProductionEvalCliHandlers()),
        promptUi,
        createAbortSignal: () => abortController.signal,
        createRenderer(task) {
          return createTranscriptRenderer({
            task,
            writers,
            color: "auto",
            isTty: Boolean(processStdout.isTTY),
          });
        },
        async runTask(task, options) {
          return runStoredSession(task, "local", options);
        },
        async runSandboxTask(task, options) {
          if (options.provider && options.provider !== "microsandbox") {
            throw new Error(`Unknown sandbox provider: ${options.provider}`);
          }
          const provider: SandboxProviderName = "microsandbox";
          return runStoredSession(task, "sandbox", options, undefined, provider);
        },
        async resumeSession(id, options) {
          const stored = await sessionStore.load(id);
          if (!stored) {
            return { kind: "generation-error", error: new Error(`Unknown session: ${id}`) };
          }
          return runStoredSession(stored.task, stored.workspaceMode, options, stored);
        },
      },
      {
        stdout: processStdout,
        stderr: processStderr,
      },
    );

    process.exitCode = exitCode;
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }
};

/** Render a ChatEvent as transcript text (Phase 3 folds this into lib/tui). */
const formatChatEvent = (event: ChatEvent): string | null => {
  switch (event.type) {
    case "turn-started":
      return `> ${event.text}`;
    case "turn-queued":
      return `(queued) ${event.text}`;
    case "tool-call":
      return `  · ${event.call.name}`;
    case "assistant": {
      // Builder turns end in a JSON completion report; show its summary.
      try {
        const report = JSON.parse(event.text) as { summary?: string; status?: string };
        if (report.summary) return `${report.status === "done" ? "✓" : "!"} ${report.summary}`;
      } catch {}
      return event.text;
    }
    case "turn-aborted":
      return "(turn interrupted)";
    case "turn-error":
      return `error: ${event.error}`;
    case "mode-changed":
      return event.pending ? `(mode → ${event.mode} at next turn)` : `(mode → ${event.mode})`;
    case "job-started":
      return `[${event.job.id}] started (${event.job.mode}): ${event.job.prompt.slice(0, 60)}`;
    case "job-finished":
      return `[${event.job.id}] ${event.job.status}${event.job.branch ? ` — work on ${event.job.branch}` : ""}`;
    case "notice":
      return event.text;
    default:
      return null;
  }
};

/**
 * The interactive chat entrypoint (temporary `agentj chat` route; becomes the
 * default in phase 3). Host-first: runs against the launch checkout with the
 * permission gate wired to the screen.
 */
export async function runAgentjChat(
  configPath: string = new URL("./agentj.json", import.meta.url).pathname,
): Promise<number> {
  const projectSource = await resolveHostProjectSource(process.cwd());
  const root = projectSource.projectRoot;
  const config = await loadConfig(configPath);
  const key = await resolveAzureApiKey({ store: createKeyringSecretStore({}) });
  if (key.status !== "resolved") {
    processStderr.write(
      "Azure API key missing; run: agentj config set --secret providers.azure.api_key\n",
    );
    return 1;
  }
  const metricsSink = createOtelMetricsSink({ enabled: process.env.AGENTJ_OTEL_METRICS === "1" });
  const environment = await createHostExecutionEnvironment(root);

  let agentsMd = "";
  try {
    agentsMd = await environment.readFile("AGENTS.md");
  } catch {}
  const agentConfig = {
    ...config.agent,
    rules: config.agent.rules || agentsMd || "",
    llm: {
      ...config.agent.llm,
      providers: {
        ...config.agent.llm.providers,
        azure: { ...config.agent.llm.providers?.azure, apiKey: key.apiKey },
      },
    },
  };
  const ctx: PromptContext = {
    cwd: root,
    os: (await environment.executeCommand("uname -sr")).stdout.trim(),
    date: new Date().toISOString().slice(0, 10),
    gitBranch:
      (await environment.executeCommand("git branch --show-current")).stdout.trim() || "HEAD",
    gitStatusSummary: summarizeStatus(
      (await environment.executeCommand("git status --porcelain")).stdout,
    ),
  };

  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const log = await createChatLog({
    root: join(stateRoot, "agentj", "chats"),
    projectRoot: root,
  });
  const undo = createUndoStack(environment, root, log.id);
  const tracker = createProgressTracker();

  // Child worktrees for build delegation and build jobs live outside the repo.
  const sessionConfig = {
    ...config.session,
    repoDir: root,
    root: join(tmpdir(), "agentj-worktrees"),
  };
  const childIds = new Set<string>();
  let childCounter = 0;
  const nextChildId = (taskId: string): string => {
    while (true) {
      childCounter += 1;
      const id = `chat-${childCounter.toString().padStart(4, "0")}-${safeChildIdSegment(taskId)}`;
      if (!childIds.has(id)) {
        childIds.add(id);
        return id;
      }
    }
  };
  const delegation = {
    parentRef: "HEAD",
    maxConcurrency: config.agent.tools.subagents.concurrency,
    createChildSession: async ({ id, parentRef }: { id: string; parentRef: string }) =>
      createChildSession(environment, sessionConfig, { id: nextChildId(id), parentRef }),
    prepareBatch: async () => {
      const snapshot = await createGitDelegationSnapshot(environment, root, log.id);
      return {
        parentRef: snapshot.commit,
        integrate: (
          results: readonly {
            index: number;
            outcome: string;
            commit: string | null;
            branch: string | null;
          }[],
        ) =>
          integrateGitDelegation(
            environment,
            root,
            log.id,
            snapshot,
            results.map((result) => ({
              index: result.index,
              outcome:
                result.outcome === "changed" || result.outcome === "clean"
                  ? (result.outcome as "changed" | "clean")
                  : result.outcome === "aborted"
                    ? ("aborted" as const)
                    : ("failure" as const),
              commit: result.commit,
              branch: result.branch,
            })),
          ),
      };
    },
  };

  // Screen and permission gate (the gate renders in the live region).
  let quitResolve: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    quitResolve = resolve;
  });
  const onDagProgress = (
    progress:
      | SubagentProgressEvent
      | Parameters<NonNullable<CreatePlanningDagToolOptions["onProgress"]>>[0],
  ) => {
    // Planning-DAG events (lanes) render via the transcript for now; the
    // unified tracker takes over fully in phase 4.
    if ("tasks" in progress || progress.type !== "dag-started") {
      tracker.apply(progress as SubagentProgressEvent);
      screen.setProgressLines(tracker.lines());
    }
  };

  const workerConfig = {
    ...agentConfig,
    llm: {
      ...agentConfig.llm,
      model: config.agent.tools.subagents.model ?? agentConfig.llm.model,
    },
  };
  const createPlanningWorker = async () =>
    createProductionAgent(environment, workerConfig, {
      root,
      ctx,
      metricsSink,
      purpose: "planning-worker",
    });

  const agents = new Map<string, Promise<Agent>>();
  const agentFor = (mode: "plan" | "build"): Promise<Agent> => {
    const cached = agents.get(mode);
    if (cached) return cached;
    const agent =
      mode === "plan"
        ? createProductionAgent(environment, agentConfig, {
            root,
            ctx,
            metricsSink,
            purpose: "planner",
            planning: { createWorker: createPlanningWorker, onProgress: onDagProgress },
          })
        : createProductionAgent(environment, agentConfig, {
            root,
            ctx,
            metricsSink,
            purpose: "builder",
            delegation,
            permissions: {
              config: config.permissions,
              gate: (request: Parameters<typeof screen.askPermission>[0]) =>
                screen.askPermission(request),
            },
          });
    agents.set(mode, agent);
    return agent;
  };

  const render = (event: ChatEvent): void => {
    const text = formatChatEvent(event);
    if (text) screen.printAbove(text);
    updateStatus();
  };

  const chat = createChatSession({ agentFor, log, undo, onEvent: render });

  // Background jobs: plan → read-only worker; build → one-task delegation batch.
  const jobs = createJobRunner({
    onEvent: render,
    addTurnNotice: (text) => chat.addTurnNotice(text),
    runJob: async ({ mode, prompt, abortSignal }) => {
      if (mode === "plan") {
        const worker = await createPlanningWorker();
        const result = await worker.generate(prompt, { abortSignal });
        return { text: result.text };
      }
      const tool = createSubagentsTool({
        execution: {
          kind: "delegation",
          ...delegation,
          createChildAgent: async ({ session }) => {
            const child = await createProductionAgent(
              environment,
              { ...agentConfig, role: "delegate" },
              {
                root: session.path,
                ctx: { ...ctx, cwd: session.path, gitBranch: session.branch },
                metricsSink,
                purpose: "builder",
              },
            );
            return {
              generate: (childPrompt, opts) =>
                child.generate(childPrompt, { abortSignal: opts?.abortSignal }),
            };
          },
        },
        concurrency: 1,
      });
      const outcome = (await tool.execute(
        { tasks: [{ title: prompt.slice(0, 72), prompt, waitsOn: [] }] },
        { abortSignal },
      )) as {
        results: Array<{
          text: string | null;
          error: string | null;
          branch: string | null;
          outcome: string;
        }>;
        integration?: { outcome: string };
      };
      const result = outcome.results[0];
      const blocked = outcome.integration?.outcome === "blocked";
      return {
        text: result?.text ?? result?.error ?? "no result",
        ...(blocked && result?.branch ? { branch: result.branch } : {}),
      };
    },
  });

  const updateStatus = (): void => {
    const running = jobs.list().filter((job) => job.status === "running").length;
    const busy = chat.busy ? " · working (esc to interrupt)" : "";
    screen.setStatus(
      `⏵ ${chat.pendingMode} · session ${log.id} · ${running} job${running === 1 ? "" : "s"}${busy} · tab: mode · /help`,
    );
  };

  const commandContext: ChatCommandContext = {
    session: chat,
    jobs,
    undo,
    emit: render,
    quit: () => quitResolve?.(),
  };

  const screen = createChatScreen({
    callbacks: {
      onSubmit: (text) => {
        const parsed = parseInput(text);
        if (parsed.kind === "command") {
          void runChatCommand(commandContext, parsed.name, parsed.args);
          return;
        }
        if (parsed.kind === "job") {
          jobs.start(chat.pendingMode, parsed.prompt);
          updateStatus();
          return;
        }
        void expandAtFiles(parsed.text, root).then((expanded) => {
          void chat.send(expanded);
          updateStatus();
        });
      },
      onTab: () => {
        chat.setMode();
        updateStatus();
      },
      onEscape: () => {
        chat.abort();
      },
      onQuit: () => quitResolve?.(),
    },
  });

  screen.start();
  updateStatus();
  screen.printAbove(`agentj chat — ${root} (${ctx.gitBranch}) · plan mode · /help for keys`);

  const handleSigint = (): void => {
    if (!chat.abort()) quitResolve?.();
  };
  process.on("SIGINT", handleSigint);
  try {
    await done;
  } finally {
    process.removeListener("SIGINT", handleSigint);
    jobs.dispose();
    await undo.dispose().catch(() => {});
    screen.stop();
  }
  return 0;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    processStderr.write(`${formatUnexpectedError(error)}\n`);
    process.exitCode = 1;
  }
}
