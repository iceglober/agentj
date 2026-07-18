import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stderr as processStderr, stdout as processStdout } from "node:process";
import packageJson from "../package.json";
import {
  type Agent,
  type AgentConfig,
  childAgentConfig,
  createAgent as createProductionAgent,
  type ToolActivity,
  withAgentModelSelection,
} from "./lib/agent";
import {
  createSessionPermissionGate,
  type PermissionGate,
  withRequestOrigin,
} from "./lib/agent/permissions";
import {
  createSubagentsTool,
  type SubagentProgressEvent,
  toGitDelegationResults,
} from "./lib/agent/subagents";
import {
  type ChatCommandContext,
  completeChatInput,
  expandAtFiles,
  type ModelSelection,
  type ModelTarget,
  parseInput,
  runChatCommand,
  shouldRememberChatInput,
} from "./lib/chat/commands";
import type { ChatEvent } from "./lib/chat/events";
import { createJobRunner } from "./lib/chat/jobs";
import { type ChatSession, createChatSession } from "./lib/chat/session";
import { EXIT_ABORTED, EXIT_FAILURE, EXIT_SUCCESS, runAgentjCli } from "./lib/cli";
import { loadChatConfig } from "./lib/config";
import {
  createConfigCliHandlers,
  createMaskedSecretPrompt,
  LLM_MODEL_KEY,
  SUBAGENT_LLM_MODEL_KEY,
} from "./lib/config-cli";
import { createEvalCliHandlers, type EvalCliHandlers } from "./lib/eval-cli";
import { providerNames, resolveTierModel } from "./lib/llm";
import {
  connectModelContextProtocolServer,
  resolveMcpTransportConfig,
} from "./lib/mcp/model-context-protocol-adapter";
import {
  createKeyringMcpOAuthStorage,
  type McpOAuthFlowResult,
  runMcpOAuthFlow,
} from "./lib/mcp/oauth";
import type { McpRuntimeStatus } from "./lib/mcp/runtime";
import { createMcpRuntime } from "./lib/mcp/runtime";
import type { MetricsSink } from "./lib/metrics";
import { createOtelMetricsSink } from "./lib/metrics/otel-adapter";
import { startMetricsProvider } from "./lib/metrics/otel-provider";
import { type PromptContext, profileNames } from "./lib/prompt";
import { resolveAzureApiKey } from "./lib/secrets";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";
import { createChildSession } from "./lib/session";
import { type ChatMode, createChatLog, latestChatLogId, loadChatLog } from "./lib/session/log";
import { createPromptHistory } from "./lib/session/prompt-history";
import { createUndoStack } from "./lib/session/undo";
import { createSpillSink } from "./lib/tools/spill";
import { truncateWithNotice } from "./lib/truncation";
import { type ChatScreen, createChatScreen } from "./lib/tui/chat-screen";
import { renderMarkdownLite } from "./lib/tui/markdown";
import {
  applyProgressEvent,
  createProgressTracker,
  formatDuration,
  type ProgressTracker,
} from "./lib/tui/progress";
import { escapeTerminalText } from "./lib/tui/terminal-editor";
import {
  createGitDelegationSnapshot,
  integrateGitDelegation,
} from "./lib/workspace/git-integration";
import { createHostExecutionEnvironment } from "./lib/workspace/host-adapter";
import { resolveProjectSource } from "./lib/workspace/project-source";

const COMMAND_VERSION = packageJson.version;

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

/** Keep a bounded single-line preview while making the omitted character count explicit. */
export const truncateLineWithNotice = (value: string, maxLength: number): string =>
  truncateWithNotice(value.replace(/\r\n?|\n/gu, " "), maxLength);

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
      return event.transcriptText ?? `> ${event.text}`;
    case "turn-queued":
      return null; // shown as a live-region line until its turn starts
    case "turn-dequeued":
      return `(dequeued) ${(event.restoreText ?? event.text).split("\n")[0]?.slice(0, 60) ?? ""}`;
    case "command":
      return `Command: ${event.name}`;
    case "tool-call":
      return null; // superseded by live tool-activity lines
    case "assistant": {
      // Builder turns end in a JSON completion report; show its summary.
      try {
        const report = JSON.parse(event.text) as { summary?: string; status?: string };
        if (report.summary) return `${report.status === "done" ? "✓" : "!"} ${report.summary}`;
      } catch {}
      // Trimmed, and null when empty (tool-only or interrupted turns) — a raw
      // body would stack blank transcript rows around the turn separators.
      const body = event.text.trim();
      if (event.stepLimitReached)
        return `${body.length > 0 ? `${body}\n` : ""}(step limit reached — turn stopped mid-work; send "continue" to resume, or raise agent.steps)`;
      return body.length > 0 ? body : null;
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

const SPINNER = ["◐", "◓", "◑", "◒"];

/** Command shown after an interactive session has restored the terminal. */
export const formatResumeCommand = (sessionId: string): string =>
  `Resume with: agentj --resume ${sessionId}\n`;

export async function finalizeInteractiveChat(options: {
  sessionId: string | undefined;
  settle: Promise<unknown>;
  stopScreen(): void;
  closeComposition(): Promise<void>;
  write?(text: string): void;
}): Promise<void> {
  try {
    options.stopScreen();
  } finally {
    try {
      await options.settle;
    } finally {
      try {
        await options.closeComposition();
      } finally {
        if (options.sessionId) {
          (options.write ?? ((text) => processStdout.write(text)))(
            formatResumeCommand(options.sessionId),
          );
        }
      }
    }
  }
}

/** Session clock: 9s → "9s", 74s → "1m14s", 3.5h → "3h30m", 30h → "1d6h0m". */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
};

/** 456 → "456", 2437 → "2.4k", 432_312 → "432.3k". */
const formatStatusTokens = (count: number): string =>
  count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;

/** Left and right hugging opposite edges; joined loosely when they cannot. */
const splitEnds = (left: string, right: string, width: number): string => {
  if (right.length === 0) return left;
  const gap = width - left.length - right.length;
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : `${left}  ${right}`;
};

/** Long paths keep their head and leaf: ~/repos/…/nested/repo. */
const middleEllipsis = (text: string, max: number): string => {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const head = Math.max(1, Math.floor((max - 1) * 0.4));
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
};

export interface StatusSectionState {
  sessionId: string;
  /** Display path of the directory the session started in — the root the
   *  session orchestrates from, however many worktrees the work fans into. */
  root: string;
  /** Provider/model label, e.g. "azure/gpt-5.6-sol". */
  model: string;
  mode: ChatMode;
  busy: boolean;
  interruptRequested: boolean;
  spinnerFrame: number;
  turnStartedAt: number | null;
  currentActivity: ToolActivity | null;
  /** Cumulative request/response tokens; ctx is the latest request's size and
   *  cacheRead the latest request's provider-cache read tokens. */
  usage: { in: number; out: number; ctx: number; cacheRead?: number };
  /** When set and ctx has reached it, the ctx counter renders flagged. */
  contextSoftLimit?: number;
  sessionStartedAt: number;
  /** Running background jobs only — each gets its own row. */
  jobs: ReadonlyArray<{ id: string; mode: ChatMode; prompt: string; startedAt: number }>;
  now?: number;
}

/**
 * The status section below the editor: identity line, root-path line with the
 * busy indicator on its right end, then one row per running background job.
 * Foreground turn activity renders above the editor, not here.
 */
/**
 * One-shot context warning: fire the first time the latest request's context
 * reaches the configured soft limit, then stay quiet for the session — the
 * model was told once; repeating the notice every step is noise.
 */
export const shouldWarnContext = (
  ctx: number,
  softLimit: number | undefined,
  alreadyWarned: boolean,
): boolean => softLimit !== undefined && !alreadyWarned && ctx >= softLimit;

export const composeStatusSection = (state: StatusSectionState, width: number): string[] => {
  const now = state.now ?? Date.now();
  const frame = SPINNER[state.spinnerFrame % SPINNER.length] ?? "◐";

  const left = `${state.sessionId} · ${state.model} · ${state.mode} (tab↕)`;
  const clock = formatClock(now - state.sessionStartedAt);
  const overLimit =
    state.contextSoftLimit !== undefined && state.usage.ctx >= state.contextSoftLimit;
  const counters = [
    formatStatusTokens(state.usage.in),
    formatStatusTokens(state.usage.out),
    `${formatStatusTokens(state.usage.ctx)}${overLimit ? "!" : ""}`,
  ] as const;
  // The latest request's cache reads, shown as a share of that request's
  // input (ctx): a live canary for prefix-cache regressions. Dropped in the
  // compact form — width wins there.
  const cacheRead = state.usage.cacheRead;
  const cached =
    cacheRead === undefined || state.usage.ctx <= 0
      ? ""
      : ` · cached ${formatStatusTokens(cacheRead)}(${Math.round((cacheRead / state.usage.ctx) * 100)}%)`;
  const labeled = `in ${counters[0]}${cached} ▸ out ${counters[1]} · ctx ${counters[2]} · ${clock}`;
  const compact = `${counters[0]}▸${counters[1]}·${counters[2]}·${clock}`;
  const right = left.length + 2 + labeled.length <= width ? labeled : compact;
  const identity = splitEnds(left, right, width);

  let busySegment = "";
  if (state.busy) {
    const doing = state.interruptRequested
      ? "interrupting…"
      : state.currentActivity
        ? state.currentActivity.tool === "run_subagents"
          ? `run_subagents (${state.currentActivity.detail})`
          : state.currentActivity.tool
        : "thinking";
    const elapsed =
      state.turnStartedAt !== null ? ` ${Math.round((now - state.turnStartedAt) / 1000)}s` : "";
    busySegment = `${frame} ${doing}${elapsed}${state.interruptRequested ? "" : " (esc)"}`;
  }
  const pathRoom = busySegment.length > 0 ? width - busySegment.length - 2 : width;
  const location = splitEnds(
    middleEllipsis(state.root, Math.max(pathRoom, 12)),
    busySegment,
    width,
  );

  const jobRows = state.jobs.map((job) => {
    const firstLine = job.prompt.split("\n")[0] ?? "";
    const snippet = firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
    return `  ${frame} [${job.id}] ${job.mode}: ${snippet}  ${formatClock(now - job.startedAt)}`;
  });

  return [identity, location, ...jobRows];
};

/**
 * Interleave running tool rows with the DAG blocks they own: each tool head
 * line is followed by its nested subagent rows; blocks with no live owner
 * (progress events that carried no activity id) render first, un-nested.
 */
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
      `  ${frame} ${tool}${detail && tool !== "run_subagents" ? ` ${truncateLineWithNotice(detail, 40)}` : ""}`,
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

interface ChatComposition {
  root: string;
  commonGitDir: string;
  ctx: PromptContext;
  /** The main agent's configured model, for display. */
  readonly llm: ModelSelection;
  modelSelections(): { primary: ModelSelection; subagents: ModelSelection | null };
  configureModel(target: ModelTarget, selection: ModelSelection | null): void;
  /** The mode's active model — the runtime selection when one is set, else
   *  the mode's ladder tier. Drives the status-line model label. */
  modelFor(mode: ChatMode): ModelSelection;
  /** The configured context soft limit (agent.context.softLimit), if any. */
  contextSoftLimit: number | undefined;
  agentFor(mode: ChatMode): Promise<Agent>;
  runBuildJob(
    prompt: string,
    abortSignal: AbortSignal,
    origin?: string,
  ): Promise<{ text: string; branch?: string }>;
  runPlanJob(prompt: string, abortSignal: AbortSignal): Promise<{ text: string }>;
  environment: Awaited<ReturnType<typeof createHostExecutionEnvironment>>;
  stateRoot: string;
  startMcp(): Promise<void>;
  reloadMcp(name?: string): Promise<void>;
  mcpStatuses(): readonly McpRuntimeStatus[];
  /** Interactive OAuth for one HTTP server; reload separately on success. */
  authorizeMcp(
    name: string,
    hooks?: { onAuthorizationUrl?(url: string): void },
  ): Promise<McpOAuthFlowResult>;
  close(): Promise<void>;
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
  onMcpStatus?: (status: McpRuntimeStatus) => void,
): Promise<ChatComposition> {
  const projectSource = await resolveProjectSource(process.cwd());
  const root = projectSource.projectRoot;
  const commonGitDir = projectSource.commonGitDir;
  const loadedConfig = await loadChatConfig(configPath);
  const config = loadedConfig.config;
  let mcpConfigIssues = loadedConfig.mcpIssues;
  const secretStore = createKeyringSecretStore({});
  const key = await resolveAzureApiKey({ store: secretStore });
  if (key.status !== "resolved") {
    throw new Error(
      "Azure API key missing; run: agentj config set --secret providers.azure.api_key",
    );
  }
  const mcpOAuth = createKeyringMcpOAuthStorage(secretStore);
  // Config-first with the historical env var kept as a fallback enable. The
  // provider is only stood up when an OTLP endpoint is configured; otherwise
  // the sink reads the global meter (an external bootstrap's, or a no-op).
  const metricsEnabled = config.metrics.enabled || process.env.AGENTJ_OTEL_METRICS === "1";
  const metricsProvider = metricsEnabled ? startMetricsProvider(config.metrics) : undefined;
  const metricsSink: MetricsSink = createOtelMetricsSink({ enabled: metricsEnabled });
  const environment = await createHostExecutionEnvironment(root);
  // Over-cap tool output spills here in full; tools reference the file in
  // their truncation notices so the model can slice it back in.
  const spillSink = createSpillSink(join(tmpdir(), "agentj-spill", sessionId));
  const spill = { dir: spillSink.dir, write: spillSink.write };

  let agentsMd = "";
  try {
    agentsMd = await environment.readFile("AGENTS.md");
  } catch {}
  let agentConfig: AgentConfig = {
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

  // Mode routing: each chat mode rides its configured ladder tier — unless
  // the user picked a model at runtime (configureModel), which wins outright.
  let primaryModelOverride = false;
  const agentConfigFor = (mode: ChatMode): AgentConfig =>
    primaryModelOverride
      ? agentConfig
      : {
          ...agentConfig,
          llm: {
            ...agentConfig.llm,
            model: resolveTierModel(agentConfig.llm, agentConfig.llm.modes[mode]),
          },
        };
  // Research workers are plan-mode children: subagent overrides/tier first,
  // else they inherit the plan tier's model. Derived per call so runtime
  // model selection applies to the next worker.
  const createResearchWorker = async () =>
    createProductionAgent(environment, childAgentConfig(agentConfigFor("plan"), "delegate"), {
      root,
      ctx,
      metricsSink,
      spill,
      mode: "plan",
      stopContextTokens: config.agent.context.softLimit,
    });

  const mcp = createMcpRuntime(config.mcp, {
    root,
    connectServer: connectModelContextProtocolServer,
    onStatus: onMcpStatus,
    oauth: mcpOAuth,
    spill: spill.write,
  });

  const agents = new Map<ChatMode, Promise<Agent>>();
  const modelSelections = (): { primary: ModelSelection; subagents: ModelSelection | null } => {
    const child = childAgentConfig(agentConfig, "delegate");
    const overridden =
      agentConfig.tools.subagents.provider !== undefined ||
      agentConfig.tools.subagents.model !== undefined ||
      agentConfig.tools.subagents.tier !== undefined;
    return {
      primary: { provider: agentConfig.llm.provider, model: agentConfig.llm.model },
      subagents: overridden ? { provider: child.llm.provider, model: child.llm.model } : null,
    };
  };
  const configureModel = (target: ModelTarget, selection: ModelSelection | null): void => {
    agentConfig = withAgentModelSelection(
      agentConfig,
      target,
      selection
        ? {
            provider: selection.provider as AgentConfig["llm"]["provider"],
            model: selection.model,
          }
        : null,
    );
    // An explicit primary selection suspends ladder mode-routing until reset.
    if (target === "primary") primaryModelOverride = selection !== null;
    agents.clear();
  };
  let agentMcpVersion = mcp.snapshot().version;
  const agentFor = async (mode: ChatMode): Promise<Agent> => {
    await mcp.activatePending();
    const mcpSnapshot = mcp.snapshot();
    if (mcpSnapshot.version !== agentMcpVersion) {
      agents.clear();
      agentMcpVersion = mcpSnapshot.version;
    }
    const cached = agents.get(mode);
    if (cached) return cached;
    const agent =
      mode === "plan"
        ? createProductionAgent(environment, agentConfigFor("plan"), {
            root,
            ctx,
            metricsSink,
            spill,
            mode: "plan",
            externalTools: mcpSnapshot.externalTools,
            research: { createWorker: createResearchWorker, onProgress: onDagProgress },
            onToolActivity,
          })
        : createProductionAgent(environment, agentConfigFor("build"), {
            root,
            ctx,
            metricsSink,
            spill,
            delegation,
            mode: "build",
            externalTools: mcpSnapshot.externalTools,
            permissions: { config: config.permissions, gate },
            onSubagentProgress: onDagProgress,
            onToolActivity,
          });
    agents.set(mode, agent);
    return agent;
  };

  const invalidServerNames = (): Set<string> =>
    new Set(mcpConfigIssues.filter(({ name }) => name !== "configuration").map(({ name }) => name));
  const issueStatuses = (): McpRuntimeStatus[] => {
    const runtimeStatuses = mcp.statuses();
    return mcpConfigIssues.map((issue) => ({
      name: issue.name,
      transport: "unknown",
      state: "failed",
      code: "invalid_config",
      detail: issue.detail,
      resolution: issue.resolution,
      usingPrevious: runtimeStatuses.some(
        (status) =>
          status.name === issue.name &&
          (status.state === "connected" ||
            status.state === "ready" ||
            (status.state === "failed" && status.usingPrevious)),
      ),
    }));
  };
  const publishConfigIssues = (): void => {
    for (const issue of issueStatuses()) onMcpStatus?.(issue);
  };
  const reloadMcp = async (name?: string): Promise<void> => {
    const latest = await loadChatConfig(configPath);
    mcpConfigIssues = latest.mcpIssues;
    publishConfigIssues();
    await mcp.reload(latest.config.mcp, name, { skip: [...invalidServerNames()] });
  };

  const authorizeMcp = async (
    name: string,
    hooks?: { onAuthorizationUrl?(url: string): void },
  ): Promise<McpOAuthFlowResult> => {
    const latest = await loadChatConfig(configPath);
    const server = latest.config.mcp.servers[name];
    if (!server) return { ok: false, reason: `no MCP server named ${name} is configured` };
    if (server.transport !== "http") {
      return { ok: false, reason: `${name} uses stdio; OAuth applies to HTTP servers` };
    }
    try {
      return await runMcpOAuthFlow(name, server.url, {
        storage: mcpOAuth,
        headers: resolveMcpTransportConfig(server).headers ?? {},
        ...(hooks?.onAuthorizationUrl ? { onAuthorizationUrl: hooks.onAuthorizationUrl } : {}),
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const runPlanJob = async (prompt: string, abortSignal: AbortSignal) => {
    const worker = await createResearchWorker();
    const result = await worker.generate(prompt, { abortSignal });
    return { text: result.text };
  };

  const runBuildJob = async (prompt: string, abortSignal: AbortSignal, origin = "job") => {
    const tool = createSubagentsTool({
      execution: {
        kind: "delegation",
        ...delegation,
        createChildAgent: async ({ session }) => {
          const child = await createProductionAgent(
            environment,
            childAgentConfig(agentConfigFor("build"), "delegate"),
            {
              root: session.path,
              ctx: { ...ctx, cwd: session.path, gitBranch: session.branch },
              metricsSink,
              spill,
              stopContextTokens: config.agent.context.softLimit,
              // Background builds answer to the same session gate, labeled.
              permissions: {
                config: config.permissions,
                gate: withRequestOrigin(gate, origin),
              },
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
    get llm() {
      return modelSelections().primary;
    },
    modelSelections,
    configureModel,
    modelFor: (mode: ChatMode) => {
      const active = agentConfigFor(mode).llm;
      return { provider: active.provider, model: active.model };
    },
    contextSoftLimit: config.agent.context.softLimit,
    agentFor,
    runBuildJob,
    runPlanJob,
    environment,
    stateRoot,
    startMcp: async () => {
      publishConfigIssues();
      await mcp.reload(config.mcp, undefined, { skip: [...invalidServerNames()] });
    },
    reloadMcp,
    authorizeMcp,
    mcpStatuses: () => {
      const invalid = invalidServerNames();
      return [...mcp.statuses().filter(({ name }) => !invalid.has(name)), ...issueStatuses()];
    },
    close: async () => {
      await mcp.close();
      await metricsProvider?.shutdown();
      spillSink.close();
    },
  };
}

/** The interactive chat session (the default command). */
export async function runAgentjChat(
  options: { resume?: string; continueLatest?: boolean } = {},
  configPath: string = new URL("./agentj.json", import.meta.url).pathname,
): Promise<number> {
  let screen: ChatScreen | undefined;
  let emitChatEvent: ((event: ChatEvent) => void) | null = null;
  const onDagProgress = (progress: SubagentProgressEvent): void => {
    emitChatEvent?.({ type: "subagent-progress", progress });
  };

  const permissionGate = createSessionPermissionGate((request) =>
    screen ? screen.askPermission(request) : Promise.resolve("deny"),
  );
  const onMcpStatus = (status: McpRuntimeStatus): void => {
    if (status.state === "failed") {
      emitChatEvent?.({
        type: "notice",
        text: `MCP ${status.name}: ${status.detail}${status.usingPrevious ? " (using previous connection)" : ""}${status.resolution ? `\n${status.resolution}` : ""}`,
      });
    }
  };

  // Live activity: what is running right now, since when. Running tools render
  // as spinner lines in the progress block (like subagents) and freeze into
  // the transcript with elapsed time when they finish.
  let currentActivity: ToolActivity | null = null;
  let turnStartedAt: number | null = null;
  let interruptRequested = false;
  let spinnerFrame = 0;
  let updateStatus = (): void => {};
  const sessionStartedAt = Date.now();
  const turnTokens: { in: number; out: number; ctx: number; cacheRead?: number } = {
    in: 0,
    out: 0,
    ctx: 0,
  };
  let contextWarned = false;
  const activeTools = new Map<number, { tool: string; detail: string; startedAt: number }>();

  // DAG progress nests under the tool activity that owns it, one tracker per
  // owner so concurrent run_subagents calls stay apart. NO_ACTIVITY collects
  // events that carried no owner id — they render un-nested, above the tools.
  const NO_ACTIVITY = -1;
  const dagTrackers = new Map<number, ProgressTracker>();
  const frozenDagBlocks = new Map<number, string[]>();
  const dagIndent = (owner: number): number => (owner === NO_ACTIVITY ? 2 : 4);
  const dagBlockLines = (): Map<number, string[]> => {
    const blocks = new Map<number, string[]>();
    for (const [owner, dagTracker] of dagTrackers) {
      const lines = dagTracker.lines(spinnerFrame, dagIndent(owner));
      if (lines.length > 0) blocks.set(owner, lines);
    }
    return blocks;
  };

  // Messages queued mid-turn wait visibly in the live region, below running
  // tools and above the editor, until their own turn starts.
  const queuedMessages: Array<{ text: string; transcriptText?: string }> = [];
  const queuedLines = (): string[] =>
    queuedMessages.map(
      ({ text, transcriptText }) =>
        `  ↳ queued: ${truncateLineWithNotice(transcriptText ?? text, 60)}`,
    );

  const refreshProgress = (): void => {
    screen?.setProgressLines(
      composeProgressLines({
        activeTools,
        dagBlocks: dagBlockLines(),
        queued: queuedLines(),
        spinnerFrame,
      }),
    );
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
      const elapsed = started ? ` ${formatDuration(Date.now() - started.startedAt)}` : "";
      // A tool that owned a DAG freezes as its head row with the children
      // nested beneath; an aborted DAG (no dag-completed) freezes its last
      // live state the same way instead of orphaning the rows.
      const live = dagTrackers.get(activity.id);
      const block =
        frozenDagBlocks.get(activity.id) ??
        (live?.live ? live.lines(spinnerFrame, dagIndent(activity.id)) : []);
      frozenDagBlocks.delete(activity.id);
      dagTrackers.delete(activity.id);
      screen?.printAbove([`  ✓ ${activity.tool}${elapsed}`, ...block].join("\n"));
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
      onMcpStatus,
    );
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }

  let resumeSessionId: string | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let handleSigint: (() => void) | undefined;
  let jobs: ReturnType<typeof createJobRunner> | undefined;
  let undo: ReturnType<typeof createUndoStack> | undefined;
  let pendingCommands = Promise.resolve();
  let pendingHistoryWrites = Promise.resolve();
  try {
    const { root, commonGitDir, ctx, agentFor, environment, stateRoot } = composition;
    const chatsRoot = join(stateRoot, "agentj", "chats");
    const promptHistory = await createPromptHistory({
      root: join(stateRoot, "agentj", "prompt-history"),
      projectIdentity: commonGitDir,
    });
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
    resumeSessionId = log.id;
    const undoStack = createUndoStack(environment, root, log.id);
    undo = undoStack;

    let quitResolve: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      quitResolve = resolve;
    });

    const render = (event: ChatEvent): void => {
      if (event.type === "turn-usage") {
        turnTokens.in += event.usage.inputTokens;
        turnTokens.out += event.usage.outputTokens;
        turnTokens.ctx = event.usage.inputTokens;
        turnTokens.cacheRead =
          event.usage.inputTokens > 0 ? event.usage.cacheReadInputTokens : undefined;
        // Only the foreground session's requests land here — subagent and job
        // usage flows through task-usage progress events — so the soft limit
        // measures exactly the context that grows this conversation.
        if (shouldWarnContext(turnTokens.ctx, composition.contextSoftLimit, contextWarned)) {
          contextWarned = true;
          chat.addTurnNotice(
            "[note] Context size crossed the configured soft limit. Wrap up soon, or delegate remaining exploration and build work to run_subagents — subagents start with fresh contexts.",
          );
        }
        updateStatus();
        return;
      }
      if (event.type === "turn-queued") {
        queuedMessages.push({
          text: event.text,
          ...(event.transcriptText ? { transcriptText: event.transcriptText } : {}),
        });
        refreshProgress();
        updateStatus();
        return;
      }
      if (event.type === "turn-started") {
        if (queuedMessages[0]?.text === event.text) {
          queuedMessages.shift();
          refreshProgress();
        }
        turnStartedAt = Date.now();
        interruptRequested = false;
      }
      if (event.type === "turn-abort-requested") interruptRequested = true;
      if (event.type === "turn-dequeued") {
        const index = queuedMessages.findLastIndex((entry) => entry.text === event.text);
        if (index !== -1) queuedMessages.splice(index, 1);
        refreshProgress();
        screen?.restoreInput(event.restoreText ?? event.text);
      }
      if (event.type === "turn-finished") {
        turnStartedAt = null;
        currentActivity = null;
        interruptRequested = false;
      }
      if (event.type === "subagent-progress") {
        const owner = event.progress.parentActivityId ?? NO_ACTIVITY;
        let dagTracker = dagTrackers.get(owner);
        if (!dagTracker) {
          dagTracker = createProgressTracker();
          dagTrackers.set(owner, dagTracker);
        }
        const update = applyProgressEvent(
          dagTracker,
          event.progress,
          spinnerFrame,
          dagIndent(owner),
        );
        if (update.completedLines.length > 0) {
          // Owned blocks wait for the tool-end row so the transcript reads
          // parent-then-children; ownerless blocks freeze immediately.
          if (owner === NO_ACTIVITY) screen?.printAbove(update.completedLines.join("\n"));
          else frozenDagBlocks.set(owner, update.completedLines);
        }
        if (!dagTracker.live) dagTrackers.delete(owner);
        refreshProgress();
      }
      // Chat styling (interactive only): a blank line + colored prefix separates
      // turns; assistant markdown renders lightly.
      if (event.type === "turn-started") {
        if (event.transcriptText) screen?.printAbove(event.transcriptText);
        else {
          screen?.printAbove(
            `\n\u001b[1m\u001b[36m❯\u001b[0m \u001b[1m${escapeTerminalText(event.text)}\u001b[0m`,
            { preStyled: true },
          );
        }
        updateStatus();
        return;
      }
      if (event.type === "assistant") {
        const body = formatChatEvent(event);
        if (body !== null)
          screen?.printAbove(`\n${renderMarkdownLite(escapeTerminalText(body))}`, {
            preStyled: true,
          });
        updateStatus();
        return;
      }
      const text = formatChatEvent(event);
      if (text) screen?.printAbove(text);
      updateStatus();
    };
    emitChatEvent = render;

    const chat: ChatSession = createChatSession(
      { agentFor, log, undo: undoStack, onEvent: render },
      resumed?.state ? { messages: resumed.state.messages, mode: resumed.state.mode } : {},
    );

    const jobRunner = createJobRunner({
      onEvent: render,
      addTurnNotice: (text) => chat.addTurnNotice(text),
      runJob: ({ id, mode, prompt, abortSignal }) =>
        mode === "plan"
          ? composition.runPlanJob(prompt, abortSignal)
          : composition.runBuildJob(prompt, abortSignal, `job ${id}`),
    });
    jobs = jobRunner;

    const home = homedir();
    const rootDisplay = root.startsWith(home) ? `~${root.slice(home.length)}` : root;
    updateStatus = (): void => {
      if (!screen) return;
      screen.setStatusLines(
        composeStatusSection(
          {
            sessionId: log.id,
            root: rootDisplay,
            model: (({ provider, model }) => `${provider}/${model}`)(
              composition.modelFor(chat.pendingMode),
            ),
            mode: chat.pendingMode,
            busy: chat.busy,
            interruptRequested,
            spinnerFrame,
            turnStartedAt,
            currentActivity,
            usage: turnTokens,
            contextSoftLimit: composition.contextSoftLimit,
            sessionStartedAt,
            jobs: jobRunner.list().filter((job) => job.status === "running"),
          },
          screen.width(),
        ),
      );
    };

    // Animate spinners and clocks. The screen skips repaints when the status
    // section is unchanged, so idle ticks cost one comparison.
    ticker = setInterval(() => {
      spinnerFrame += 1;
      if (dagTrackers.size > 0 || activeTools.size > 0) refreshProgress();
      updateStatus();
    }, 250);

    const configOutput = (message: string): void => {
      const text = message.trim();
      if (text) render({ type: "notice", text });
    };
    const interactiveConfig = createConfigCliHandlers({
      secretStore: createKeyringSecretStore({}),
      prompt: {
        askSecret: () =>
          screen?.askInput({ label: "Secret value", masked: true }) ?? Promise.resolve(null),
      },
      writers: {
        stdout: { write: configOutput },
        stderr: { write: configOutput },
      },
    });
    const commandContext: ChatCommandContext = {
      session: chat,
      jobs: jobRunner,
      undo: undoStack,
      emit: render,
      quit: () => quitResolve?.(),
      config: interactiveConfig,
      models: {
        current: composition.modelSelections,
        providers: () => providerNames,
        modelSuggestions: (provider) => {
          const selections = composition.modelSelections();
          return [
            ...(selections.primary.provider === provider ? [selections.primary.model] : []),
            ...(selections.subagents?.provider === provider ? [selections.subagents.model] : []),
            ...profileNames,
          ].filter((value, index, values) => values.indexOf(value) === index);
        },
        configure: async (target, selection) => {
          const key = target === "primary" ? LLM_MODEL_KEY : SUBAGENT_LLM_MODEL_KEY;
          const result = selection
            ? await interactiveConfig.set({
                key,
                value: `${selection.provider}/${selection.model}`,
              })
            : await interactiveConfig.delete({ key });
          if (!result.ok) return false;
          composition.configureModel(target, selection);
          updateStatus();
          return true;
        },
      },
      mcp: {
        statuses: composition.mcpStatuses,
        reload: composition.reloadMcp,
        authorize: composition.authorizeMcp,
      },
      guided: {
        askInput: (inputOptions) => screen?.askInput(inputOptions) ?? Promise.resolve(null),
      },
    };

    screen = createChatScreen({
      initialHistory: promptHistory.entries,
      slashCommandOptions: (state) => completeChatInput(state.text, state.cursor, commandContext),
      shouldRememberInput: shouldRememberChatInput,
      callbacks: {
        onSubmit: (text) => {
          if (shouldRememberChatInput(text)) rememberPrompt(text);
          const parsed = parseInput(text);
          if (parsed.kind === "command") {
            pendingCommands = pendingCommands.then(() =>
              runChatCommand(commandContext, parsed.name, parsed.args),
            );
            return;
          }
          if (parsed.kind === "job") {
            jobRunner.start(chat.pendingMode, parsed.prompt);
            updateStatus();
            return;
          }
          void expandAtFiles(parsed.text, root).then((expanded) => {
            void chat.send(expanded, { restoreText: parsed.text });
            updateStatus();
          });
        },
        onTab: () => {
          chat.setMode();
          updateStatus();
        },
        onEscape: () => {
          // Escalation ladder: undo the newest pending intent first, then interrupt.
          if (chat.dequeue() !== null) return;
          chat.abort();
        },
        onQuit: () => quitResolve?.(),
      },
    });

    screen.start();
    updateStatus();
    for (const turn of (resumed?.turns ?? []).slice(-5)) {
      screen.printAbove(turn.transcriptText ?? `> ${turn.user}`);
      screen.printAbove(turn.assistant);
    }
    void composition.startMcp().catch((error) => {
      render({
        type: "notice",
        text: `Unable to load MCP configuration: ${error instanceof Error ? error.message : String(error)}`,
      });
    });

    handleSigint = (): void => {
      if (chat.dequeue() !== null) return;
      if (!chat.abort()) quitResolve?.();
    };
    process.on("SIGINT", handleSigint);
    await done;
    return EXIT_SUCCESS;
  } finally {
    emitChatEvent = null;
    if (ticker) clearInterval(ticker);
    if (handleSigint) process.removeListener("SIGINT", handleSigint);
    jobs?.dispose();
    await finalizeInteractiveChat({
      sessionId: resumeSessionId,
      settle: Promise.all([
        pendingCommands,
        pendingHistoryWrites,
        undo?.dispose().catch(() => {}) ?? Promise.resolve(),
      ]),
      stopScreen: () => screen?.stop(),
      closeComposition: () => composition.close().catch(() => undefined),
    });
  }
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
          processStderr.write(
            `  · ${activity.tool}: ${truncateLineWithNotice(activity.detail, 80)}\n`,
          );
        }
      },
      (status) => {
        if (status.state === "failed") {
          processStderr.write(
            `MCP ${status.name}: ${status.detail}${status.resolution ? ` — ${status.resolution}` : ""}\n`,
          );
        }
      },
    );
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }

  try {
    await composition.startMcp();
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
        `${formatChatEvent({ type: "assistant", mode: chat.mode, text: resultText }) ?? ""}\n`,
      );
      return EXIT_SUCCESS;
    }
    return outcome === "aborted" ? EXIT_ABORTED : EXIT_FAILURE;
  } finally {
    await composition.close().catch(() => undefined);
  }
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
