import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stderr as processStderr, stdout as processStdout } from "node:process";

import { type Agent, createAgent as createProductionAgent, type ToolActivity } from "./lib/agent";
import { createSessionPermissionGate, type PermissionGate } from "./lib/agent/permissions";
import {
  createSubagentsTool,
  type SubagentProgressEvent,
  toGitDelegationResults,
} from "./lib/agent/subagents";
import {
  type ChatCommandContext,
  expandAtFiles,
  parseInput,
  runChatCommand,
} from "./lib/chat/commands";
import type { ChatEvent } from "./lib/chat/events";
import { createJobRunner } from "./lib/chat/jobs";
import { type ChatSession, createChatSession } from "./lib/chat/session";
import { EXIT_ABORTED, EXIT_FAILURE, EXIT_SUCCESS, runAgentjCli } from "./lib/cli";
import { loadConfig } from "./lib/config";
import { createConfigCliHandlers, createMaskedSecretPrompt } from "./lib/config-cli";
import { createEvalCliHandlers, type EvalCliHandlers } from "./lib/eval-cli";
import type { MetricsSink } from "./lib/metrics";
import { createOtelMetricsSink } from "./lib/metrics/otel-adapter";
import type { PromptContext } from "./lib/prompt";
import { resolveAzureApiKey } from "./lib/secrets";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";
import { createChildSession } from "./lib/session";
import { type ChatMode, createChatLog, latestChatLogId, loadChatLog } from "./lib/session/log";
import { createPromptHistory } from "./lib/session/prompt-history";
import { createUndoStack } from "./lib/session/undo";
import { type ChatScreen, createChatScreen } from "./lib/tui/chat-screen";
import { renderMarkdownLite } from "./lib/tui/markdown";
import { escapeTerminalText } from "./lib/tui/terminal-editor";
import { applyProgressEvent, createProgressTracker } from "./lib/tui/progress";
import {
  createGitDelegationSnapshot,
  integrateGitDelegation,
} from "./lib/workspace/git-integration";
import { createHostExecutionEnvironment } from "./lib/workspace/host-adapter";
import { resolveProjectSource } from "./lib/workspace/project-source";

const COMMAND_VERSION = "0.0.0";

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

/** Render a ChatEvent as transcript text. */
export const formatChatEvent = (event: ChatEvent): string | null => {
  switch (event.type) {
    case "turn-started":
      return `> ${event.text}`;
    case "turn-queued":
      return `(queued) ${event.text}`;
    case "tool-call":
      return null; // superseded by live tool-activity lines
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

export const formatChatStatus = (state: {
  mode: ChatMode;
  sessionId: string;
  runningJobs: number;
  busy: boolean;
  interruptRequested: boolean;
  spinnerFrame: number;
  turnStartedAt: number | null;
  currentActivity: ToolActivity | null;
  now?: number;
}): string => {
  let busy = "";
  if (state.busy) {
    const spinner = ["◐", "◓", "◑", "◒"];
    const frame = spinner[state.spinnerFrame % spinner.length] ?? "◐";
    const elapsed =
      state.turnStartedAt !== null
        ? ` ${Math.round(((state.now ?? Date.now()) - state.turnStartedAt) / 1000)}s`
        : "";
    const doing = state.interruptRequested
      ? "interrupting…"
      : state.currentActivity
        ? state.currentActivity.tool === "run_subagents"
          ? `run_subagents (${state.currentActivity.detail})`
          : state.currentActivity.tool
        : "thinking";
    busy = ` · ${frame} ${doing}${elapsed}${state.interruptRequested ? "" : " (esc to interrupt)"}`;
  }
  return `⏵ ${state.mode} · session ${state.sessionId} · ${state.runningJobs} job${state.runningJobs === 1 ? "" : "s"}${busy} · tab: mode · /help`;
};

interface ChatComposition {
  root: string;
  commonGitDir: string;
  ctx: PromptContext;
  agentFor(mode: ChatMode): Promise<Agent>;
  runBuildJob(prompt: string, abortSignal: AbortSignal): Promise<{ text: string; branch?: string }>;
  runPlanJob(prompt: string, abortSignal: AbortSignal): Promise<{ text: string }>;
  environment: Awaited<ReturnType<typeof createHostExecutionEnvironment>>;
  stateRoot: string;
}

/**
 * Everything both entrypoints share: host environment, configured agents per
 * mode (with delegation for build), and job executors. The permission gate is
 * injected — interactive runs wire it to the screen, `run` wires it to policy.
 */
async function composeChat(
  configPath: string,
  sessionId: string,
  gate: PermissionGate,
  onDagProgress: (progress: SubagentProgressEvent) => void,
  onToolActivity?: (activity: ToolActivity) => void,
): Promise<ChatComposition> {
  const projectSource = await resolveProjectSource(process.cwd());
  const root = projectSource.projectRoot;
  const commonGitDir = projectSource.commonGitDir;
  const config = await loadConfig(configPath);
  const key = await resolveAzureApiKey({ store: createKeyringSecretStore({}) });
  if (key.status !== "resolved") {
    throw new Error(
      "Azure API key missing; run: agentj config set --secret providers.azure.api_key",
    );
  }
  const metricsSink: MetricsSink = createOtelMetricsSink({
    enabled: process.env.AGENTJ_OTEL_METRICS === "1",
  });
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
      const snapshot = await createGitDelegationSnapshot(environment, root, sessionId);
      return {
        parentRef: snapshot.commit,
        integrate: (results: readonly Parameters<typeof toGitDelegationResults>[0][number][]) =>
          integrateGitDelegation(
            environment,
            root,
            sessionId,
            snapshot,
            toGitDelegationResults(results),
          ),
      };
    },
  };

  const workerConfig = {
    ...agentConfig,
    llm: {
      ...agentConfig.llm,
      model: config.agent.tools.subagents.model ?? agentConfig.llm.model,
    },
  };
  const createResearchWorker = async () =>
    createProductionAgent(
      environment,
      { ...workerConfig, role: "delegate" },
      { root, ctx, metricsSink, mode: "plan" },
    );

  const agents = new Map<ChatMode, Promise<Agent>>();
  const agentFor = (mode: ChatMode): Promise<Agent> => {
    const cached = agents.get(mode);
    if (cached) return cached;
    const agent =
      mode === "plan"
        ? createProductionAgent(environment, agentConfig, {
            root,
            ctx,
            metricsSink,
            mode: "plan",
            research: { createWorker: createResearchWorker, onProgress: onDagProgress },
            onToolActivity,
          })
        : createProductionAgent(environment, agentConfig, {
            root,
            ctx,
            metricsSink,
            delegation,
            permissions: { config: config.permissions, gate },
            onSubagentProgress: onDagProgress,
            onToolActivity,
          });
    agents.set(mode, agent);
    return agent;
  };

  const runPlanJob = async (prompt: string, abortSignal: AbortSignal) => {
    const worker = await createResearchWorker();
    const result = await worker.generate(prompt, { abortSignal });
    return { text: result.text };
  };

  const runBuildJob = async (prompt: string, abortSignal: AbortSignal) => {
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
            },
          );
          return {
            generate: (childPrompt, opts) =>
              child.generate(childPrompt, {
                abortSignal: opts?.abortSignal,
                onStep: opts?.onStep,
              }),
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
  };

  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return {
    root,
    commonGitDir,
    ctx,
    agentFor,
    runBuildJob,
    runPlanJob,
    environment,
    stateRoot,
  };
}

/** The interactive chat session (the default command). */
export async function runAgentjChat(
  options: { resume?: string; continueLatest?: boolean } = {},
  configPath: string = new URL("./agentj.json", import.meta.url).pathname,
): Promise<number> {
  const tracker = createProgressTracker();
  let screen: ChatScreen | undefined;
  let emitChatEvent: ((event: ChatEvent) => void) | null = null;
  const onDagProgress = (progress: SubagentProgressEvent): void => {
    emitChatEvent?.({ type: "subagent-progress", progress });
  };

  const permissionGate = createSessionPermissionGate((request) =>
    screen ? screen.askPermission(request) : Promise.resolve("deny"),
  );

  // Live activity: what is running right now, since when. Running tools render
  // as spinner lines in the progress block (like subagents) and freeze into
  // the transcript with elapsed time when they finish.
  let currentActivity: ToolActivity | null = null;
  let turnStartedAt: number | null = null;
  let interruptRequested = false;
  let spinnerFrame = 0;
  let dagLines: string[] = [];
  const activeTools = new Map<number, { tool: string; detail: string; startedAt: number }>();
  const SPINNER = ["◐", "◓", "◑", "◒"];

  const toolLines = (): string[] =>
    [...activeTools.values()].map(
      ({ tool, detail }) =>
        `  ${SPINNER[spinnerFrame % SPINNER.length] ?? "◐"} ${tool}${detail && tool !== "run_subagents" ? ` ${detail.slice(0, 40)}` : ""}`,
    );

  const refreshProgress = (): void => {
    screen?.setProgressLines([...dagLines, ...toolLines()]);
  };

  const onToolActivity = (activity: ToolActivity): void => {
    if (activity.phase === "start") {
      currentActivity = activity;
      activeTools.set(activity.id, {
        tool: activity.tool,
        detail: activity.detail,
        startedAt: Date.now(),
      });
    } else {
      const started = activeTools.get(activity.id);
      activeTools.delete(activity.id);
      currentActivity = null;
      const elapsed = started ? ` ${((Date.now() - started.startedAt) / 1000).toFixed(1)}s` : "";
      screen?.printAbove(`  ✓ ${activity.tool}${elapsed}`);
    }
    refreshProgress();
    updateStatus();
  };

  let composition: ChatComposition;
  try {
    composition = await composeChat(
      configPath,
      "chat",
      permissionGate,
      onDagProgress,
      onToolActivity,
    );
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
  const { root, commonGitDir, ctx, agentFor, environment, stateRoot } = composition;
  const chatsRoot = join(stateRoot, "agentj", "chats");
  const promptHistory = await createPromptHistory({
    root: join(stateRoot, "agentj", "prompt-history"),
    projectIdentity: commonGitDir,
  });
  let pendingHistoryWrites = Promise.resolve();
  const rememberPrompt = (text: string): void => {
    pendingHistoryWrites = pendingHistoryWrites
      .then(() => promptHistory.append(text))
      .catch((error) => {
        screen?.printAbove(
          `prompt history error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  // Resume: --continue picks the newest session for this project.
  let resumeId = options.resume ?? null;
  if (!resumeId && options.continueLatest) {
    resumeId = await latestChatLogId({ root: chatsRoot, projectRoot: root });
    if (!resumeId) {
      processStderr.write("No previous chat session for this project.\n");
      return EXIT_FAILURE;
    }
  }
  const resumed = resumeId
    ? await loadChatLog({ root: chatsRoot, projectRoot: root, id: resumeId })
    : null;
  if (resumeId && !resumed) {
    processStderr.write(`Unknown chat session: ${resumeId}\n`);
    return EXIT_FAILURE;
  }

  const log = await createChatLog({
    root: chatsRoot,
    projectRoot: root,
    ...(resumeId ? { id: resumeId } : {}),
  });
  const undo = createUndoStack(environment, root, log.id);

  let quitResolve: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    quitResolve = resolve;
  });

  const render = (event: ChatEvent): void => {
    if (event.type === "turn-started") {
      turnStartedAt = Date.now();
      interruptRequested = false;
    }
    if (event.type === "turn-abort-requested") interruptRequested = true;
    if (event.type === "turn-finished") {
      turnStartedAt = null;
      currentActivity = null;
      interruptRequested = false;
    }
    if (event.type === "subagent-progress") {
      const update = applyProgressEvent(tracker, event.progress, spinnerFrame);
      if (update.completedLines.length > 0) screen?.printAbove(update.completedLines.join("\n"));
      dagLines = update.lines;
      refreshProgress();
    }
    // Chat styling (interactive only): a blank line + colored prefix separates
    // turns; assistant markdown renders lightly.
    if (event.type === "turn-started") {
      screen?.printAbove(
        `\n\u001b[1m\u001b[36m❯\u001b[0m \u001b[1m${escapeTerminalText(event.text)}\u001b[0m`,
        { preStyled: true },
      );
      updateStatus();
      return;
    }
    if (event.type === "assistant") {
      const body = formatChatEvent(event) ?? event.text;
      screen?.printAbove(`\n${renderMarkdownLite(escapeTerminalText(body))}`, { preStyled: true });
      updateStatus();
      return;
    }
    const text = formatChatEvent(event);
    if (text) screen?.printAbove(text);
    updateStatus();
  };
  emitChatEvent = render;

  const chat: ChatSession = createChatSession(
    { agentFor, log, undo, onEvent: render },
    resumed?.state ? { messages: resumed.state.messages, mode: resumed.state.mode } : {},
  );

  const jobs = createJobRunner({
    onEvent: render,
    addTurnNotice: (text) => chat.addTurnNotice(text),
    runJob: ({ mode, prompt, abortSignal }) =>
      mode === "plan"
        ? composition.runPlanJob(prompt, abortSignal)
        : composition.runBuildJob(prompt, abortSignal),
  });

  const updateStatus = (): void => {
    const runningJobs = jobs.list().filter((job) => job.status === "running").length;
    screen?.setStatus(
      formatChatStatus({
        mode: chat.pendingMode,
        sessionId: log.id,
        runningJobs,
        busy: chat.busy,
        interruptRequested,
        spinnerFrame,
        turnStartedAt,
        currentActivity,
      }),
    );
  };

  // Animate the spinner and elapsed time while anything is running.
  const ticker = setInterval(() => {
    spinnerFrame += 1;
    if (tracker.live) dagLines = tracker.lines(spinnerFrame);
    if (tracker.live || activeTools.size > 0) refreshProgress();
    if (chat.busy || jobs.list().some((job) => job.status === "running")) updateStatus();
  }, 250);

  const commandContext: ChatCommandContext = {
    session: chat,
    jobs,
    undo,
    emit: render,
    quit: () => quitResolve?.(),
  };

  screen = createChatScreen({
    initialHistory: promptHistory.entries,
    callbacks: {
      onSubmit: (text) => {
        rememberPrompt(text);
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
  screen.printAbove(
    `agentj — ${root} (${ctx.gitBranch}) · ${chat.mode} mode${resumed ? ` · resumed ${log.id}` : ""} · /help for keys`,
  );
  for (const turn of (resumed?.turns ?? []).slice(-5)) {
    screen.printAbove(`> ${turn.user}`);
    screen.printAbove(turn.assistant);
  }

  const handleSigint = (): void => {
    if (!chat.abort()) quitResolve?.();
  };
  process.on("SIGINT", handleSigint);
  try {
    await done;
  } finally {
    clearInterval(ticker);
    process.removeListener("SIGINT", handleSigint);
    jobs.dispose();
    await Promise.all([pendingHistoryWrites, undo.dispose().catch(() => {})]);
    screen.stop();
  }
  return EXIT_SUCCESS;
}

/** Non-interactive one-shot: one turn, transcript to stderr, result to stdout. */
export async function runAgentjOnce(
  task: string,
  options: { plan: boolean; allowAll: boolean; signal: AbortSignal },
  configPath: string = new URL("./agentj.json", import.meta.url).pathname,
): Promise<number> {
  const gate: PermissionGate = async (request) => {
    if (options.allowAll) return "allow";
    processStderr.write(`denied (no TTY): ${request.tool} ${request.detail}\n`);
    return "deny";
  };

  let composition: ChatComposition;
  try {
    composition = await composeChat(
      configPath,
      "run",
      gate,
      (progress) => {
        if (progress.type === "task-completed" || progress.type === "task-failed") {
          processStderr.write(`subagent ${progress.id}: ${progress.type.slice(5)}\n`);
        }
      },
      (activity) => {
        if (activity.phase === "start") {
          processStderr.write(`  · ${activity.tool}: ${activity.detail.slice(0, 80)}\n`);
        }
      },
    );
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }

  const log = await createChatLog({
    root: join(composition.stateRoot, "agentj", "chats"),
    projectRoot: composition.root,
    title: task,
  });
  const undo = createUndoStack(composition.environment, composition.root, log.id);

  let outcome: "done" | "aborted" | "error" = "done";
  let resultText = "";
  const chat = createChatSession(
    {
      agentFor: composition.agentFor,
      log,
      undo,
      onEvent: (event) => {
        if (event.type === "assistant") {
          resultText = event.text;
          return;
        }
        if (event.type === "turn-aborted") outcome = "aborted";
        if (event.type === "turn-error") outcome = "error";
        const text = formatChatEvent(event);
        if (text) processStderr.write(`${text}\n`);
      },
    },
    { mode: options.plan ? "plan" : "build" },
  );

  const onAbort = (): void => {
    chat.abort();
  };
  options.signal.addEventListener("abort", onAbort);
  try {
    await chat.send(task);
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    await undo.dispose().catch(() => {});
  }

  if (outcome === "done") {
    processStdout.write(
      `${formatChatEvent({ type: "assistant", mode: chat.mode, text: resultText }) ?? resultText}\n`,
    );
    return EXIT_SUCCESS;
  }
  return outcome === "aborted" ? EXIT_ABORTED : EXIT_FAILURE;
}

const formatUnexpectedError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const abortController = new AbortController();
  const handleSigint = (): void => {
    abortController.abort();
  };

  const writers = {
    stdout: processStdout,
    stderr: processStderr,
  };
  const configHandlers = createConfigCliHandlers({
    secretStore: createKeyringSecretStore({}),
    prompt: createMaskedSecretPrompt(),
    writers,
  });

  process.on("SIGINT", handleSigint);
  try {
    process.exitCode = await runAgentjCli(
      argv,
      {
        version: COMMAND_VERSION,
        runChat: (options) => runAgentjChat(options),
        runOnce: (task, options) => runAgentjOnce(task, options),
        createAbortSignal: () => abortController.signal,
        configHandlers,
        createEvalHandlers: () => createProductionEvalCliHandlers(),
      },
      writers,
    );
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    processStderr.write(`${formatUnexpectedError(error)}\n`);
    process.exitCode = 1;
  }
}
