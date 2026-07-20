import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stderr as processStderr, stdout as processStdout } from "node:process";
import { fileURLToPath } from "node:url";
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
import type { TodoPort } from "./lib/agent/todos";
import {
  type ChatCommandContext,
  chatCommands,
  completeChatInput,
  type ModelSelection,
  type ModelTarget,
  parseInput,
  runChatCommand,
  type SkillCommand,
  shouldRememberChatInput,
  suggestChatInputRoots,
} from "./lib/chat/commands";
import { type ConfigUiPort, runConfigUi } from "./lib/chat/config-ui";
import { LONG_CONTEXT_INPUT_TOKENS, type UsageRecord } from "./lib/chat/cost";
import type { ChatEvent } from "./lib/chat/events";
import {
  createPastedImageRegistry,
  expandFileAttachments,
  formatFileReference,
  formatFileReferences,
} from "./lib/chat/file-attachments";
import { createJobRunner, type JobRunner } from "./lib/chat/jobs";
import { runOnboarding } from "./lib/chat/onboarding";
import { createPromptsGuidedInput } from "./lib/chat/prompts-guided-input-adapter";
import { type ChatSession, createChatSession } from "./lib/chat/session";
import { createSessionTodos } from "./lib/chat/todos";
import { EXIT_ABORTED, EXIT_FAILURE, EXIT_SUCCESS, runAgentjCli } from "./lib/cli";
import { loadChatConfig, loadConfig } from "./lib/config";
import { createConfigCliHandlers, LLM_MODEL_KEY, SUBAGENT_LLM_MODEL_KEY } from "./lib/config-cli";
import { createEvalCliHandlers, type EvalCliHandlers } from "./lib/eval-cli";
import { providerNames, type RunStep, resolveTierModel } from "./lib/llm";
import type { McpPromptCatalogEntry, McpPromptResult } from "./lib/mcp";
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
import {
  AZURE_API_KEY_ACCOUNT,
  AZURE_SECRET_SERVICE,
  hasAzureApiKey,
  resolveAzureApiKey,
} from "./lib/secrets";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";
import { createChildSession } from "./lib/session";
import { type ChatMode, createChatLog, latestChatLogId, loadChatLog } from "./lib/session/log";
import { createPromptHistory } from "./lib/session/prompt-history";
import { createUndoStack } from "./lib/session/undo";
import {
  composeSkillsPromptSection,
  discoverSkills,
  embeddedSkillsRoot,
  renderSkillInvocation,
  type Skill,
  type SkillIssue,
  skillMode,
} from "./lib/skills";
import type { TodoList } from "./lib/todos";
import { createSpillSink } from "./lib/tools/spill";
import { truncateWithNotice } from "./lib/truncation";
import { createAnsiLiveRegionAdapter } from "./lib/tui/ansi-live-region-adapter";
import { type ChatScreen, createChatScreen } from "./lib/tui/chat-screen";
import { ClipboardAttachmentsUnavailableError } from "./lib/tui/clipboard";
import { formatCompletionReportText } from "./lib/tui/completion-report";
import { createCrosscopyClipboardAttachments } from "./lib/tui/crosscopy-clipboard-adapter";
import { createEditorCompletionProvider } from "./lib/tui/editor-completion";
import { renderMarkdownLite } from "./lib/tui/markdown";
import {
  applyProgressEvent,
  composeProgressLines,
  createProgressTracker,
  formatDuration,
  type ProgressTracker,
} from "./lib/tui/progress";
import {
  composeStatusSection,
  composeThinkingLine,
  formatClock,
  shouldWarnContext,
} from "./lib/tui/status";
import type { UiTextLine } from "./lib/tui/styles";
import { formatTodoLines } from "./lib/tui/todos";
import { createUpdateService, type UpdateChannel, type UpdateService } from "./lib/update";
import {
  createNpmInstaller,
  createNpmRegistryAdapter,
  createUpdateStateStore,
} from "./lib/update/npm-adapter";
import {
  createDelegationChildIdFactory,
  delegationWorktreeRoot,
} from "./lib/workspace/delegation-identity";
import {
  createGitDelegationSnapshot,
  integrateGitDelegation,
} from "./lib/workspace/git-integration";
import { createGitProjectFileSource } from "./lib/workspace/git-project-file-source";
import { createHostExecutionEnvironment } from "./lib/workspace/host-adapter";
import { createProjectFileCatalog } from "./lib/workspace/project-files";
import { resolveProjectSource } from "./lib/workspace/project-source";

const COMMAND_VERSION = packageJson.version;

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

/** `agentj config` with no subcommand: a prompts-driven editor over the config
 *  keys, persisting through the same handlers as `config set`. */
function createProductionConfigUi(): () => Promise<number> {
  return async () => {
    if (!processStdout.isTTY) {
      processStderr.write("Run `agentj config` in a terminal, or use `agentj config set <key>`.\n");
      return EXIT_FAILURE;
    }
    const guided = createPromptsGuidedInput();
    const silent = { write: () => {} };
    const handlers = createConfigCliHandlers({
      secretStore: createKeyringSecretStore({}),
      prompt: {
        askSecret: () => guided.askInput({ label: "Secret value · <Esc> Back", masked: true }),
      },
      writers: { stdout: silent, stderr: silent },
    });
    const port: ConfigUiPort = {
      ...guided,
      read: async (path) => {
        const result = await handlers.get({ key: path });
        return result.ok ? result.value : undefined;
      },
      apply: async (path, value) => {
        const result = await handlers.set({ key: path, value });
        if (!result.ok) processStdout.write(`Could not set ${path}.\n`);
        return result.ok;
      },
      applySecret: async (path, value) => {
        const result = await handlers.setSecret({ key: path, value });
        if (!result.ok) processStdout.write(`Could not set ${path}.\n`);
        return result.ok;
      },
      note: (text) => processStdout.write(`${text}\n`),
    };
    await runConfigUi(port);
    return EXIT_SUCCESS;
  };
}

export const formatActivityReceipt = (count: number, elapsedMs: number): string =>
  `✓ ${count} ${count === 1 ? "tool" : "tools"} · ${formatDuration(elapsedMs)} · /activity for details`;

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
      const completion = formatCompletionReportText(event.text);
      if (completion) return completion;
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
    case "job-finished": {
      const elapsed = formatClock((event.job.endedAt ?? Date.now()) - event.job.startedAt);
      const result = event.job.resultText?.trim();
      const branch = event.job.branch ? `\nwork preserved on ${event.job.branch}` : "";
      const marker = event.job.status === "done" ? "✓" : event.job.status === "failed" ? "x" : "!";
      return `${marker} [${event.job.id}] ${event.job.status} in ${elapsed} — ${event.job.prompt.slice(0, 60)}${result ? `\n${truncateWithNotice(result, 2_000)}` : ""}${branch}`;
    }
    case "notice":
      return event.text;
    default:
      return null;
  }
};

/** Keep activity state legible in monochrome while giving active outcomes a semantic tone. */
const presentActivityLine = (text: string): UiTextLine => {
  const trimmed = text.trimStart();
  const tone = trimmed.startsWith("✓")
    ? "success"
    : trimmed.startsWith("x")
      ? "danger"
      : trimmed.startsWith("↳ queued")
        ? "warning"
        : trimmed.startsWith("◐") ||
            trimmed.startsWith("◓") ||
            trimmed.startsWith("◑") ||
            trimmed.startsWith("◒")
          ? "accent"
          : trimmed.startsWith("·")
            ? "muted"
            : undefined;
  return tone ? [{ text, tone }] : text;
};

/** Command shown after an interactive session has restored the terminal. */
export const formatResumeCommand = (sessionId: string): string =>
  `Resume with: agentj --resume ${sessionId}\n`;

export async function finalizeInteractiveChat(options: {
  sessionId: string | undefined;
  settle: Promise<unknown>;
  stopScreen(): void;
  closeComposition(): Promise<void>;
  /** Runs only after raw terminal and composition resources are closed. */
  afterClose?(): Promise<void>;
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
        await options.afterClose?.();
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

export { composeProgressLines } from "./lib/tui/progress";
export {
  composeStatusSection,
  composeThinkingLine,
  formatClock,
  type StatusSectionState,
  shouldWarnContext,
} from "./lib/tui/status";

/** Convert discovered skills into the catalog available to slash-command routing. */
export const toSkillCommands = (skills: readonly Skill[]): SkillCommand[] =>
  skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => {
      const mode = skillMode(skill);
      return {
        name: skill.name,
        summary: skill.description,
        ...(mode ? { mode } : {}),
        prompt: (args) => renderSkillInvocation(skill, args),
      };
    });

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
  /** The eval $/Mtok map, reused by /cost for terminal pricing. */
  evalPrices: Readonly<Record<string, { in: number; out: number }>>;
  agentFor(mode: ChatMode): Promise<Agent>;
  runBuildJob(
    prompt: string,
    abortSignal: AbortSignal,
    origin?: string,
    onStep?: (step: RunStep) => void,
  ): Promise<{ text: string; status?: "failed"; branch?: string }>;
  runPlanJob(
    prompt: string,
    abortSignal: AbortSignal,
    origin?: string,
    onStep?: (step: RunStep) => void,
  ): Promise<{ text: string }>;
  /** Late-binds interactive capabilities behind primary-agent tools. */
  attachInteractiveCapabilities(options: {
    jobs: Pick<JobRunner, "start" | "inspect" | "renewSoftTimeout" | "abort">;
    todos: TodoPort;
  }): void;
  environment: Awaited<ReturnType<typeof createHostExecutionEnvironment>>;
  stateRoot: string;
  /** Discovered Agent Skills and the malformed entries worth surfacing. */
  skills: readonly Skill[];
  skillIssues: readonly SkillIssue[];
  startMcp(): Promise<void>;
  reloadMcp(name?: string): Promise<void>;
  mcpStatuses(): readonly McpRuntimeStatus[];
  mcpPrompts(): readonly McpPromptCatalogEntry[];
  getMcpPrompt(
    server: string,
    prompt: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult>;
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
  entrypoint: "chat" | "run",
  gate: PermissionGate,
  onDagProgress: (progress: SubagentProgressEvent) => void,
  onToolActivity?: (activity: ToolActivity) => void,
  onMcpStatus?: (status: McpRuntimeStatus) => void,
): Promise<ChatComposition> {
  const projectSource = await resolveProjectSource(process.cwd());
  const root = projectSource.projectRoot;
  const commonGitDir = projectSource.commonGitDir;
  const configLoadOptions = { baseConfigPath: configPath, projectRoot: root };
  const loadedConfig = await loadChatConfig(undefined, configLoadOptions);
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
  const spillSink = createSpillSink(join(tmpdir(), "agentj-spill", entrypoint));
  const spill = { dir: spillSink.dir, write: spillSink.write };

  let agentsMd = "";
  try {
    agentsMd = await environment.readFile("AGENTS.md");
  } catch {}
  // Agent Skills (agentskills.io): project skills win over global ones. Their
  // names/descriptions ride the rules so every mode and entrypoint can
  // activate a skill by reading its SKILL.md (progressive disclosure).
  const skillsDiscovery = await discoverSkills({
    roots: [
      join(root, ".aj", "skills"),
      join(homedir(), ".config", "agentj", "skills"),
      embeddedSkillsRoot,
    ],
  });
  const skillsSection = composeSkillsPromptSection(skillsDiscovery.skills);
  let agentConfig: AgentConfig = {
    ...config.agent,
    rules: [agentsMd, config.agent.rules, skillsSection].filter(Boolean).join("\n\n"),
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

  // Child worktrees stay outside the repo, but are scoped to its common Git
  // directory. Each composition also gets a nonce, so stale worktrees and
  // branches from a prior process can never collide with a new child.
  const sessionConfig = {
    ...config.session,
    repoDir: root,
    root: delegationWorktreeRoot(tmpdir(), commonGitDir),
  };
  const nextChildId = createDelegationChildIdFactory();
  const delegation = {
    parentRef: "HEAD",
    maxConcurrency: config.agent.tools.subagents.concurrency,
    createChildSession: async ({ id, parentRef }: { id: string; parentRef: string }) =>
      createChildSession(environment, sessionConfig, { id: nextChildId(id), parentRef }),
    prepareBatch: async () => {
      const snapshot = await createGitDelegationSnapshot(environment, root, entrypoint);
      return {
        parentRef: snapshot.commit,
        integrate: (results: readonly Parameters<typeof toGitDelegationResults>[0][number][]) =>
          integrateGitDelegation(
            environment,
            root,
            entrypoint,
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
  // model selection applies to the next worker. Their observation bash
  // answers to the same session gate, labeled with who is asking.
  const createResearchWorker = async (origin?: string) =>
    createProductionAgent(environment, childAgentConfig(agentConfigFor("plan"), "delegate"), {
      root,
      ctx,
      metricsSink,
      spill,
      mode: "plan",
      stopContextTokens: config.agent.context.softLimit,
      permissions: {
        config: config.permissions,
        gate: origin ? withRequestOrigin(gate, origin) : gate,
      },
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
  let jobsRuntime: Pick<JobRunner, "start" | "inspect" | "renewSoftTimeout" | "abort"> | undefined;
  let todosRuntime: TodoPort | undefined;
  const jobsPort = {
    start: (
      mode: "plan" | "build",
      prompt: string,
      options?: { softTimeoutMs?: number },
    ): { id: string } | { error: string } =>
      jobsRuntime
        ? { id: jobsRuntime.start(mode, prompt, options).id }
        : { error: "Background jobs are unavailable in this session." },
    inspect: (id: string) => jobsRuntime?.inspect(id),
    renewSoftTimeout: (id: string, softTimeoutMs: number) =>
      jobsRuntime?.renewSoftTimeout(id, softTimeoutMs) ?? false,
    abort: (id: string) => jobsRuntime?.abort(id) ?? false,
  };
  const todosPort: TodoPort = {
    replace: async (items) => {
      if (!todosRuntime) throw new Error("Session todos are unavailable in this session.");
      await todosRuntime.replace(items);
    },
  };
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
            research: {
              createWorker: (task) => createResearchWorker(`subagent ${task.id}`),
              onProgress: onDagProgress,
            },
            onToolActivity,
            permissions: { config: config.permissions, gate },
            jobs: jobsPort,
            ...(entrypoint === "chat" ? { todos: todosPort } : {}),
          })
        : createProductionAgent(environment, agentConfigFor("build"), {
            root,
            ctx,
            metricsSink,
            spill,
            delegation,
            mode: "build",
            externalTools: mcpSnapshot.externalTools,
            createChildExternalTools: (childRoot, signal) =>
              mcp.createChildConnection(childRoot, signal),
            permissions: { config: config.permissions, gate },
            onSubagentProgress: onDagProgress,
            onToolActivity,
            jobs: jobsPort,
            ...(entrypoint === "chat" ? { todos: todosPort } : {}),
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
    const latest = await loadChatConfig(undefined, configLoadOptions);
    mcpConfigIssues = latest.mcpIssues;
    publishConfigIssues();
    await mcp.reload(latest.config.mcp, name, { skip: [...invalidServerNames()] });
  };

  const authorizeMcp = async (
    name: string,
    hooks?: { onAuthorizationUrl?(url: string): void },
  ): Promise<McpOAuthFlowResult> => {
    const latest = await loadChatConfig(undefined, configLoadOptions);
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

  const runPlanJob = async (
    prompt: string,
    abortSignal: AbortSignal,
    origin = "job",
    onStep?: (step: RunStep) => void,
  ) => {
    const worker = await createResearchWorker(origin);
    const result = await worker.generate(prompt, { abortSignal, onStep });
    return { text: result.text };
  };

  const runBuildJob = async (
    prompt: string,
    abortSignal: AbortSignal,
    origin = "job",
    onStep?: (step: RunStep) => void,
  ) => {
    const tool = createSubagentsTool({
      execution: {
        kind: "delegation",
        ...delegation,
        createChildAgent: async ({ session, abortSignal: childAbortSignal }) => {
          const externalLease = await mcp.createChildConnection(
            session.path,
            childAbortSignal ?? abortSignal,
          );
          let child: Agent;
          try {
            child = await createProductionAgent(
              environment,
              childAgentConfig(agentConfigFor("build"), "delegate"),
              {
                root: session.path,
                ctx: { ...ctx, cwd: session.path, gitBranch: session.branch },
                metricsSink,
                spill,
                stopContextTokens: config.agent.context.softLimit,
                childExternalTools: externalLease.externalTools,
                // Background builds answer to the same session gate, labeled.
                permissions: {
                  config: config.permissions,
                  gate: withRequestOrigin(gate, origin),
                },
              },
            );
          } catch (error) {
            await externalLease.close();
            throw error;
          }
          return {
            generate: async (childPrompt, opts) => {
              try {
                return await child.generate(childPrompt, {
                  abortSignal: opts?.abortSignal,
                  // Tee steps to the job runner's activity trail alongside the
                  // scheduler's own usage tracking.
                  onStep: (step) => {
                    opts?.onStep?.(step);
                    onStep?.(step);
                  },
                });
              } finally {
                await externalLease.close();
              }
            },
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
        preserved: boolean;
        warnings: string[];
      }>;
      integration?: { outcome: string; detail: string | null };
    };
    const result = outcome.results[0];
    const blocked = outcome.integration?.outcome === "blocked";
    const succeeded = result?.outcome === "changed" || result?.outcome === "clean";
    const failed = blocked || !succeeded;
    const integrationDetail = blocked
      ? `Integration blocked${outcome.integration?.detail ? `: ${outcome.integration.detail}` : "."}`
      : undefined;
    return {
      text:
        [result?.error, integrationDetail, result?.text]
          .filter((detail): detail is string => Boolean(detail))
          .join("\n") || "no result",
      ...(failed ? { status: "failed" as const } : {}),
      ...(result?.preserved && result.branch ? { branch: result.branch } : {}),
      ...(result?.warnings.length ? { warnings: result.warnings } : {}),
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
    evalPrices: config.eval.prices,
    agentFor,
    runBuildJob,
    runPlanJob,
    attachInteractiveCapabilities: ({ jobs, todos }) => {
      jobsRuntime = jobs;
      todosRuntime = todos;
    },
    environment,
    stateRoot,
    skills: skillsDiscovery.skills,
    skillIssues: skillsDiscovery.issues,
    startMcp: async () => {
      publishConfigIssues();
      await mcp.reload(config.mcp, undefined, { skip: [...invalidServerNames()] });
    },
    reloadMcp,
    authorizeMcp,
    mcpPrompts: () => mcp.prompts(),
    getMcpPrompt: (server, prompt, args) => mcp.getPrompt(server, prompt, args),
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
  configPath: string = new URL("./agentj.ts", import.meta.url).pathname,
  update?: (channel: UpdateChannel) => Promise<void>,
): Promise<number> {
  let requestedUpdate: UpdateChannel | undefined;
  let screen: ChatScreen | undefined;
  let emitChatEvent: ((event: ChatEvent) => void) | null = null;
  const onDagProgress = (progress: SubagentProgressEvent): void => {
    emitChatEvent?.({ type: "subagent-progress", progress });
  };

  let updateStatus = (): void => {};
  let permissionPending = false;
  const permissionGate = createSessionPermissionGate(async (request) => {
    permissionPending = true;
    updateStatus();
    try {
      return await (screen ? screen.askPermission(request) : Promise.resolve("deny"));
    } finally {
      permissionPending = false;
      updateStatus();
    }
  });
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
  let turnStartedAt: number | null = null;
  let interruptRequested = false;
  // Did the running turn surface anything (a tool row or assistant text)? A
  // turn that ends with none — an empty model reply — otherwise renders
  // nothing, which looks identical to a freeze.
  let turnProducedOutput = false;
  let spinnerFrame = 0;
  let sessionStartedAt = Date.now();
  const turnTokens: { in: number; out: number; ctx: number; cacheRead?: number } = {
    in: 0,
    out: 0,
    ctx: 0,
  };
  let lastContextWarning: number | undefined;
  const activeTools = new Map<number, { tool: string; detail: string; startedAt: number }>();
  let sessionTodos: TodoList = [];
  const completedActivities: Array<{ tool: string; detail: string; elapsedMs: number }> = [];
  let turnActivityCount = 0;

  // DAG progress nests under the tool activity that owns it, one tracker per
  // owner so concurrent run_subagents calls stay apart. NO_ACTIVITY collects
  // events that carried no owner id — they render un-nested, above the tools.
  const NO_ACTIVITY = -1;
  const dagTrackers = new Map<number, ProgressTracker>();
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
      [
        ...formatTodoLines(sessionTodos),
        ...composeProgressLines({
          activeTools,
          dagBlocks: dagBlockLines(),
          queued: queuedLines(),
          spinnerFrame,
        }),
      ].map(presentActivityLine),
    );
  };

  const onToolActivity = (activity: ToolActivity): void => {
    if (activity.phase === "start") {
      activeTools.set(activity.id, {
        tool: activity.tool,
        detail: activity.detail,
        startedAt: Date.now(),
      });
    } else {
      const started = activeTools.get(activity.id);
      activeTools.delete(activity.id);
      const elapsedMs = started ? Date.now() - started.startedAt : 0;
      dagTrackers.delete(activity.id);
      completedActivities.push({
        tool: activity.tool,
        detail: started?.detail ?? activity.detail,
        elapsedMs,
      });
      if (completedActivities.length > 100) completedActivities.shift();
      turnActivityCount += 1;
      turnProducedOutput = true;
    }
    refreshProgress();
    updateStatus();
  };

  // First-run gate: walk the user through setting a provider key before
  // standing up the session, which otherwise hard-errors on a missing key.
  // Interactive TTY only — `agentj run` and pipes keep the clean error.
  if (processStdout.isTTY) {
    const onboardingStore = createKeyringSecretStore({});
    const guided = createPromptsGuidedInput();
    const onboarding = await runOnboarding({
      hasKey: () => hasAzureApiKey({ store: onboardingStore }),
      askSecret: () =>
        guided.askInput({ label: "Azure AI Foundry API key · <Esc> Back", masked: true }),
      storeKey: (value) => onboardingStore.set(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT, value),
      write: (text) => processStdout.write(text),
    });
    if (onboarding === "cancelled") return EXIT_FAILURE;
  }

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
    // Foreground usage ledger: resumed rows plus one appended record per turn.
    // Only foreground steps land in turn-usage, so /cost prices exactly the
    // context this conversation grew.
    const usageRows: UsageRecord[] = [...(resumed?.usage ?? [])];
    let turnUsage: UsageRecord["usage"] | null = null;
    let turnModel = composition.modelFor(resumed?.state?.mode ?? "plan");

    let quitResolve: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      quitResolve = resolve;
    });

    const render = (event: ChatEvent): void => {
      if (event.type === "todos-updated") {
        sessionTodos = event.items;
        refreshProgress();
        return;
      }
      if (event.type === "context-cleared") {
        usageRows.length = 0;
        turnUsage = null;
        turnTokens.in = 0;
        turnTokens.out = 0;
        turnTokens.ctx = 0;
        delete turnTokens.cacheRead;
        lastContextWarning = undefined;
        turnStartedAt = null;
        interruptRequested = false;
        turnProducedOutput = false;
        turnActivityCount = 0;
        completedActivities.length = 0;
        sessionStartedAt = Date.now();
        screen?.clearTranscript();
        refreshProgress();
        updateStatus();
        return;
      }
      if (event.type === "turn-usage") {
        turnTokens.in += event.usage.inputTokens;
        turnTokens.out += event.usage.outputTokens;
        turnTokens.ctx = event.usage.inputTokens;
        if (event.usage.cacheReadInputTokens !== undefined) {
          turnTokens.cacheRead = (turnTokens.cacheRead ?? 0) + event.usage.cacheReadInputTokens;
        }
        if (turnUsage) {
          turnUsage.inputTokens += event.usage.inputTokens;
          turnUsage.outputTokens += event.usage.outputTokens;
          if (event.usage.cacheReadInputTokens !== undefined) {
            turnUsage.cacheReadInputTokens =
              (turnUsage.cacheReadInputTokens ?? 0) + event.usage.cacheReadInputTokens;
          }
          if (event.usage.cacheWriteInputTokens !== undefined) {
            turnUsage.cacheWriteInputTokens =
              (turnUsage.cacheWriteInputTokens ?? 0) + event.usage.cacheWriteInputTokens;
          }
          if (event.usage.inputTokens > LONG_CONTEXT_INPUT_TOKENS)
            turnUsage.longContextRequests += 1;
        }
        // Only the foreground session's requests land here — subagent and job
        // usage flows through task-usage progress events — so the soft limit
        // measures exactly the context that grows this conversation.
        if (shouldWarnContext(turnTokens.ctx, composition.contextSoftLimit, lastContextWarning)) {
          lastContextWarning = turnTokens.ctx;
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
        turnProducedOutput = false;
        turnActivityCount = 0;
        turnModel = composition.modelFor(event.mode);
        turnUsage = { inputTokens: 0, outputTokens: 0, longContextRequests: 0 };
      }
      if (event.type === "turn-abort-requested") interruptRequested = true;
      if (event.type === "turn-dequeued") {
        const index = queuedMessages.findLastIndex((entry) => entry.text === event.text);
        if (index !== -1) queuedMessages.splice(index, 1);
        refreshProgress();
        screen?.restoreInput(event.restoreText ?? event.text);
      }
      if (event.type === "turn-finished") {
        const elapsedMs = turnStartedAt === null ? 0 : Date.now() - turnStartedAt;
        if (turnActivityCount > 0) {
          screen?.printAbove([
            [
              {
                text: formatActivityReceipt(turnActivityCount, elapsedMs),
                tone: "success",
              },
            ],
          ]);
        }
        turnStartedAt = null;
        interruptRequested = false;
        if (turnUsage && turnUsage.inputTokens + turnUsage.outputTokens > 0) {
          const record: UsageRecord = {
            type: "usage",
            provider: turnModel.provider,
            model: turnModel.model,
            ts: new Date().toISOString(),
            usage: turnUsage,
          };
          usageRows.push(record);
          void log.append(record);
        }
        turnUsage = null;
      }
      if (event.type === "subagent-progress") {
        const owner = event.progress.parentActivityId ?? NO_ACTIVITY;
        let dagTracker = dagTrackers.get(owner);
        if (!dagTracker) {
          dagTracker = createProgressTracker();
          dagTrackers.set(owner, dagTracker);
        }
        applyProgressEvent(dagTracker, event.progress, spinnerFrame, dagIndent(owner));
        if (!dagTracker.live) dagTrackers.delete(owner);
        refreshProgress();
      }
      // Chat styling (interactive only): a blank line + colored prefix separates
      // turns; assistant markdown renders lightly.
      if (event.type === "turn-started") {
        if (event.transcriptText) screen?.printAbove(event.transcriptText);
        else {
          screen?.printAbove([
            [
              { text: "❯", tone: "accent", bold: true },
              { text: " " },
              { text: event.text, bold: true },
            ],
          ]);
        }
        updateStatus();
        return;
      }
      if (event.type === "assistant") {
        const body = formatChatEvent(event);
        if (body !== null) {
          turnProducedOutput = true;
          screen?.printAbove(renderMarkdownLite(body));
        } else if (!turnProducedOutput) {
          // The turn ran, showed no tool work, and the model returned no text —
          // say so, or the turn is indistinguishable from a hang.
          screen?.printAbove([
            [{ text: "(no response — the model returned nothing; try again)", tone: "muted" }],
          ]);
        }
        updateStatus();
        return;
      }
      if (event.type === "turn-error") {
        turnProducedOutput = true;
        const filtered = /content management policy|content filter|was filtered/i.test(event.error);
        screen?.printAbove([
          [{ text: `error: ${event.error}`, tone: "danger" }],
          ...(filtered
            ? [
                [
                  {
                    text: "The provider's content filter rejected this request. It often fires intermittently — retry once; if it keeps happening, start a new session (aj) instead of resuming this one.",
                    tone: "muted" as const,
                  },
                ],
              ]
            : []),
        ]);
        updateStatus();
        return;
      }
      const text = formatChatEvent(event);
      if (text) {
        turnProducedOutput = true;
        screen?.printAbove(text);
      }
      updateStatus();
    };
    emitChatEvent = render;

    const todos = createSessionTodos({
      log,
      initial: resumed?.todos,
      onEvent: render,
    });
    sessionTodos = todos.items;
    const chat: ChatSession = createChatSession(
      {
        agentFor,
        log,
        undo: undoStack,
        todos,
        onEvent: render,
      },
      resumed?.state ? { messages: resumed.state.messages, mode: resumed.state.mode } : {},
    );

    const jobRunner = createJobRunner({
      onEvent: render,
      addTurnNotice: (text) => chat.addTurnNotice(text),
      runJob: ({ id, mode, prompt, abortSignal, onStep }) =>
        mode === "plan"
          ? composition.runPlanJob(prompt, abortSignal, `job ${id}`, onStep)
          : composition.runBuildJob(prompt, abortSignal, `job ${id}`, onStep),
      // The soft-timeout ping rides the normal turn queue: it waits out a busy
      // foreground turn and shows in the transcript only once its turn runs.
      ping: (job) => {
        void chat.send(
          `[system] Background job ${job.id} reached its soft timeout and is still running — prompt: "${job.prompt.slice(0, 80)}". Check it with check_job, then renew its soft timeout if it is progressing or abort it if it is stuck.`,
          { transcriptText: `[${job.id}] soft timeout reached — checking on it` },
        );
      },
    });
    jobs = jobRunner;
    composition.attachInteractiveCapabilities({ jobs: jobRunner, todos });

    const home = homedir();
    const rootDisplay = root.startsWith(home) ? `~${root.slice(home.length)}` : root;
    updateStatus = (): void => {
      if (!screen) return;
      screen.setThinkingLine(
        composeThinkingLine(
          {
            thinking: chat.busy && activeTools.size === 0 && !permissionPending,
            interruptRequested,
            spinnerFrame,
            turnStartedAt,
          },
          screen.width(),
        ),
      );
      screen.setStatusLines(
        composeStatusSection(
          {
            sessionId: log.id,
            version: COMMAND_VERSION,
            root: rootDisplay,
            model: (({ provider, model }) => `${provider}/${model}`)(
              composition.modelFor(chat.pendingMode),
            ),
            mode: chat.pendingMode,
            spinnerFrame,
            usage: turnTokens,
            contextSoftLimit: composition.contextSoftLimit,
            sessionStartedAt,
            jobs: jobRunner
              .list()
              .filter((job) => job.status === "running")
              .map((job) => ({
                id: job.id,
                mode: job.mode,
                prompt: job.prompt,
                startedAt: job.startedAt,
              })),
          },
          screen.width(),
        ).map((text) => [{ text, tone: "muted" }]),
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
    const skillCommands = toSkillCommands(composition.skills);
    const commandContext: ChatCommandContext = {
      session: chat,
      jobs: jobRunner,
      undo: undoStack,
      emit: render,
      quit: () => quitResolve?.(),
      requestUpdate: (channel) => {
        requestedUpdate = channel;
      },
      config: interactiveConfig,
      cost: { rows: () => usageRows, prices: composition.evalPrices },
      activity: { list: () => completedActivities },
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
        prompts: composition.mcpPrompts,
        getPrompt: composition.getMcpPrompt,
        reload: composition.reloadMcp,
        authorize: composition.authorizeMcp,
      },
      guided: {
        askInput: (inputOptions) => screen?.askInput(inputOptions) ?? Promise.resolve(null),
      },
      skills: skillCommands,
    };
    const skillNotices = [
      ...composition.skillIssues.map(({ path, detail }) => `skill ${path}: ${detail}`),
      ...skillCommands
        .filter(({ name }) => name in chatCommands)
        .map(({ name }) => `skill ${name} is shadowed by the built-in /${name} command.`),
    ];

    const liveRegion = createAnsiLiveRegionAdapter({ stdout: processStdout });
    const clipboardAttachments = createCrosscopyClipboardAttachments();
    const pastedImages = createPastedImageRegistry();
    const projectFiles = createProjectFileCatalog(createGitProjectFileSource(environment, root));
    await projectFiles.refresh();
    screen = createChatScreen({
      liveRegion,
      initialHistory: promptHistory.entries,
      matchesSlashCommand: (query) => suggestChatInputRoots(query, commandContext).length > 0,
      editorCompletionOptions: createEditorCompletionProvider({
        completeInitialSlash: (state) =>
          completeChatInput(state.text, state.cursor, commandContext),
        suggestInlineSlash: (query) => suggestChatInputRoots(query, commandContext),
        suggestFiles: (query) =>
          projectFiles.suggest(query).map((path) => ({
            value: formatFileReference(path),
            label: formatFileReference(path),
            summary: "Project file",
          })),
      }),
      shouldRememberInput: (text) =>
        shouldRememberChatInput(text) && !pastedImages.hasReference(text),
      callbacks: {
        onSubmit: (text) => {
          if (shouldRememberChatInput(text) && !pastedImages.hasReference(text))
            rememberPrompt(text);
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
          void expandFileAttachments(parsed.text, root).then((expanded) => {
            const images = [...pastedImages.resolve(parsed.text), ...expanded.images];
            void chat.send(expanded.text, {
              restoreText: parsed.text,
              ...(images.length > 0 ? { images } : {}),
            });
            updateStatus();
          });
        },
        onTab: () => {
          chat.setMode();
          updateStatus();
        },
        onPasteFiles: async () => {
          try {
            const attachment = await clipboardAttachments.read();
            if (attachment?.kind === "files") {
              const references = formatFileReferences(attachment.paths);
              if (references) return ` ${references} `;
            }
            if (attachment?.kind === "image") {
              const added = pastedImages.add(attachment.image);
              if ("error" in added) {
                render({ type: "notice", text: added.error });
                return null;
              }
              return ` ${added.marker} `;
            }
            render({
              type: "notice",
              text: "Ctrl+V attaches files copied in your file manager or a copied screenshot — the clipboard has neither right now. To paste text, use your terminal's paste (⌘V).",
            });
            return null;
          } catch (error) {
            render({
              type: "notice",
              text:
                error instanceof ClipboardAttachmentsUnavailableError
                  ? "Reading attachments from the system clipboard isn't available here."
                  : `Couldn't read attachments from the clipboard: ${error instanceof Error ? error.message : String(error)}`,
            });
            return null;
          }
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
    refreshProgress();
    updateStatus();
    for (const notice of skillNotices) render({ type: "notice", text: notice });
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
    const updateChannel = requestedUpdate;
    await finalizeInteractiveChat({
      sessionId: resumeSessionId,
      settle: Promise.all([
        pendingCommands,
        pendingHistoryWrites,
        undo?.dispose().catch(() => {}) ?? Promise.resolve(),
      ]),
      stopScreen: () => screen?.stop(),
      closeComposition: () => composition.close().catch(() => undefined),
      afterClose: updateChannel && update ? () => update(updateChannel) : undefined,
    });
  }
}

/** Non-interactive one-shot: one turn, transcript to stderr, result to stdout. */
export async function runAgentjOnce(
  task: string,
  options: { plan: boolean; allowAll: boolean; signal: AbortSignal },
  configPath: string = new URL("./agentj.ts", import.meta.url).pathname,
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
    for (const { path, detail } of composition.skillIssues) {
      processStderr.write(`skill ${path}: ${detail}\n`);
    }
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

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const createProductionUpdateService = async (): Promise<{
  service: UpdateService;
  supported: boolean;
  auto: boolean;
}> => {
  const config = await loadConfig();
  const installer = createNpmInstaller({ packageRoot });
  return {
    service: createUpdateService({
      config: config.update,
      packageName: "@glrs-dev/aj",
      registry: createNpmRegistryAdapter(),
      ...(installer ? { installer } : {}),
      state: createUpdateStateStore(),
    }),
    supported: installer !== undefined,
    auto: config.update.auto,
  };
};

const runProductionUpdate = async (channel: UpdateChannel): Promise<number> => {
  try {
    const { service } = await createProductionUpdateService();
    const result = await service.update(COMMAND_VERSION, channel);
    if (result.available) {
      processStdout.write(`Updated agentj to ${result.available} (${result.channel}).\n`);
    } else {
      processStdout.write(`agentj ${COMMAND_VERSION} is current on ${result.channel}.\n`);
    }
    return EXIT_SUCCESS;
  } catch (error) {
    processStderr.write(
      `Unable to update agentj: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
  }
};

const shouldAutoUpdate = (argv: string[]): boolean =>
  process.env.AGENTJ_UPDATE_RESTARTED !== "1" &&
  argv[0] !== "update" &&
  argv[0] !== "config" &&
  argv[0] !== "eval" &&
  !argv.includes("--help") &&
  !argv.includes("-h") &&
  !argv.includes("--version") &&
  !argv.includes("-v");

export interface UpdateRestartOptions {
  cmd: string[];
  stdin: "inherit";
  stdout: "inherit";
  stderr: "inherit";
  env: Record<string, string | undefined>;
}

export const createUpdateRestartOptions = (
  argv: string[],
  options: {
    executable?: string;
    script?: string;
    env?: Record<string, string | undefined>;
  } = {},
): UpdateRestartOptions => ({
  cmd: [options.executable ?? process.execPath, options.script ?? process.argv[1]!, ...argv],
  stdin: "inherit" as const,
  stdout: "inherit" as const,
  stderr: "inherit" as const,
  env: { ...(options.env ?? process.env), AGENTJ_UPDATE_RESTARTED: "1" },
});

const autoUpdate = async (argv: string[]): Promise<number | undefined> => {
  if (!shouldAutoUpdate(argv)) return undefined;
  try {
    const { service, supported, auto } = await createProductionUpdateService();
    if (!auto || !supported) return undefined;
    const result = await service.check(COMMAND_VERSION);
    if (!result.available) return undefined;
    const updated = await service.update(COMMAND_VERSION);
    if (!updated.available) return undefined;
    processStderr.write(`Updating agentj to ${updated.available} (${updated.channel})...\n`);
    const child = Bun.spawn(createUpdateRestartOptions(argv));
    return await child.exited;
  } catch (error) {
    processStderr.write(
      `AgentJ auto-update skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
};

const formatUnexpectedError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const autoUpdateExitCode = await autoUpdate(argv);
  if (autoUpdateExitCode !== undefined) {
    process.exitCode = autoUpdateExitCode;
    return;
  }

  const abortController = new AbortController();
  const handleSigint = (): void => {
    abortController.abort();
  };

  const writers = {
    stdout: processStdout,
    stderr: processStderr,
  };
  const guided = createPromptsGuidedInput();
  const configHandlers = createConfigCliHandlers({
    secretStore: createKeyringSecretStore({}),
    prompt: {
      askSecret: () => guided.askInput({ label: "Secret value · <Esc> Back", masked: true }),
    },
    writers,
  });

  process.on("SIGINT", handleSigint);
  try {
    process.exitCode = await runAgentjCli(
      argv,
      {
        version: COMMAND_VERSION,
        runChat: (options) =>
          runAgentjChat(options, undefined, async (channel) => {
            if ((await runProductionUpdate(channel)) !== EXIT_SUCCESS) {
              throw new Error("AgentJ update failed.");
            }
          }),
        runOnce: (task, options) => runAgentjOnce(task, options),
        update: ({ channel }) => runProductionUpdate(channel),
        createAbortSignal: () => abortController.signal,
        configHandlers,
        runConfigUi: createProductionConfigUi(),
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
