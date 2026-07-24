import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stderr as processStderr, stdout as processStdout } from "node:process";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import {
  type Agent,
  type AgentConfig,
  childAgentConfig,
  createAgentModelRouting,
  createAgent as createProductionAgent,
  type ToolActivity,
} from "./lib/agent";
import { prepareBackgroundJobPrompt } from "./lib/agent/background-jobs";
import {
  createSessionPermissionGate,
  type PermissionGate,
  withRequestOrigin,
} from "./lib/agent/permissions";
import {
  runSubagentTasks,
  type SubagentProgressEvent,
  toGitDelegationResults,
} from "./lib/agent/subagents";
import { createClackGuidedInput } from "./lib/chat/clack-guided-input-adapter";
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
import { createChatEventOrderer } from "./lib/chat/event-order";
import type { ChatEvent } from "./lib/chat/events";
import {
  createPastedImageRegistry,
  expandFileAttachments,
  formatFileReference,
  formatFileReferences,
} from "./lib/chat/file-attachments";
import {
  createInteractiveCapabilityBinder,
  type InteractiveCapabilities,
} from "./lib/chat/interactive-capabilities";
import { createJobRunner } from "./lib/chat/jobs";
import { runOnboarding } from "./lib/chat/onboarding";
import { createPromptsGuidedInput } from "./lib/chat/prompts-guided-input-adapter";
import { createQuestionPort } from "./lib/chat/questions";
import { type ChatSession, createChatSession } from "./lib/chat/session";
import { bootstrapInteractiveSession } from "./lib/chat/session-bootstrap";
import { createSessionTodos } from "./lib/chat/todos";
import { EXIT_ABORTED, EXIT_FAILURE, EXIT_SUCCESS, runGloriousCli } from "./lib/cli";
import {
  loadChatConfig,
  loadConfig,
  mutateConfigLayer,
  readConfigLayers,
  resolveConfigLayerPath,
  type WritableConfigLayer,
} from "./lib/config";
import { createConfigCliHandlers, LLM_MODEL_KEY, SUBAGENT_LLM_MODEL_KEY } from "./lib/config-cli";
import { createEvalCliHandlers, type EvalCliHandlers } from "./lib/eval-cli";
import { type ProviderName, providerNames, type RunStep } from "./lib/llm";
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
import { createMcpSessionController } from "./lib/mcp/session-controller";
import type { MetricsSink } from "./lib/metrics";
import { createOtelMetricsSink } from "./lib/metrics/otel-adapter";
import { startMetricsProvider } from "./lib/metrics/otel-provider";
import { type PromptContext, profileNames } from "./lib/prompt";
import {
  AZURE_API_KEY_ACCOUNT,
  AZURE_SECRET_SERVICE,
  hasAzureApiKey,
  resolveAzureApiKey,
  resolveProviderKey,
  type SecretStore,
} from "./lib/secrets";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";
import { createChildSession } from "./lib/session";
import { type ChatMode, createChatLog } from "./lib/session/log";
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
import { createSpillSink } from "./lib/tools/spill";
import { createExaWebSearch } from "./lib/tools/web/exa-adapter";
import { createHttpWebFetch } from "./lib/tools/web/http-adapter";
import { createAnsiLiveRegionAdapter } from "./lib/tui/ansi-live-region-adapter";
import {
  formatChatEvent,
  presentActivityLine,
  truncateLineWithNotice,
} from "./lib/tui/chat-event-format";
import { type ChatScreen, createChatScreen } from "./lib/tui/chat-screen";
import { ClipboardAttachmentsUnavailableError } from "./lib/tui/clipboard";
import { type ConfigTuiHost, createConfigTuiHost } from "./lib/tui/config-tui/host";
import { runConfigTuiScreen } from "./lib/tui/config-tui/screen";
import { createCrosscopyClipboardAttachments } from "./lib/tui/crosscopy-clipboard-adapter";
import { createEditorCompletionProvider } from "./lib/tui/editor-completion";
import { createOpenTuiChatScreen } from "./lib/tui/opentui-chat-screen";
import {
  applyProgressEvent,
  composeProgressLines,
  createProgressTracker,
  type ProgressTracker,
} from "./lib/tui/progress";
import { composeStatusSection, formatVuMeter, shouldWarnContext } from "./lib/tui/status";
import type { UiSpan, UiTextLine } from "./lib/tui/styles";
import { formatTodoProgressLines } from "./lib/tui/todos";
import { formatUserTurnBlock } from "./lib/tui/transcript";
import {
  renderToolRow,
  renderTranscriptItem,
  type ToolRow,
  toTranscriptItem,
} from "./lib/tui/transcript-item";
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

/** The bundled base config path (below the user-writable layers). */
function baseConfigPath(): string {
  return new URL("./glorious.ts", import.meta.url).pathname;
}

/**
 * The active provider's API key. Azure (the default) keeps its env fallback and,
 * when required, hard-fails with a fix-it message; every other provider uses its
 * keychain key when present, else the AI SDK reads the provider's own env var.
 */
async function resolveActiveProviderKey(
  provider: ProviderName,
  store: SecretStore,
  options: { require?: boolean } = {},
): Promise<string | undefined> {
  if (provider === "azure") {
    const key = await resolveAzureApiKey({ store });
    if (key.status === "resolved") return key.apiKey;
    if (options.require)
      throw new Error(
        "Azure API key missing; run: glorious config set --secret providers.azure.api_key",
      );
    return undefined;
  }
  return resolveProviderKey(provider, store);
}

/** Inject a resolved key into the active provider's slot, leaving others intact. */
function withProviderKey(
  llm: AgentConfig["llm"],
  provider: ProviderName,
  apiKey: string | undefined,
): AgentConfig["llm"] {
  if (!apiKey) return llm;
  return {
    ...llm,
    providers: {
      ...llm.providers,
      [provider]: { ...llm.providers?.[provider], apiKey },
    },
  };
}

/** The interactive config-TUI host for a project, wired to the real config
 *  layers and keychain. Shared by `glorious config` and in-chat `/config`. */
function createProjectConfigTuiHost(
  secretStore: SecretStore,
  configOptions: { baseConfigPath: string; projectRoot: string },
): ConfigTuiHost {
  const home = process.env.HOME ?? "";
  const root = configOptions.projectRoot;
  // Shorten for display: home → ~, and project files relative to the root.
  const displayPath = (layer: WritableConfigLayer): string => {
    const path = resolveConfigLayerPath(layer, configOptions) ?? "";
    if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
    if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
    return path;
  };
  return createConfigTuiHost({
    loadConfig: () => loadConfig(undefined, configOptions),
    loadLayers: () => readConfigLayers(configOptions),
    mutate: (layer, mutations) => mutateConfigLayer(layer, mutations, configOptions),
    hasKey: async () => Boolean(await secretStore.get(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT)),
    layerPaths: {
      global: displayPath("global"),
      project: displayPath("project"),
      local: displayPath("local"),
    },
  });
}

/** `glorious config` with no subcommand: a prompts-driven editor over the config
 *  keys, persisting through the same handlers as `config set`. */
function createProductionConfigUi(): () => Promise<number> {
  return async () => {
    if (!processStdout.isTTY) {
      processStderr.write(
        "Run `glorious config` in a terminal, or use `glorious config set <key>`.\n",
      );
      return EXIT_FAILURE;
    }
    const guided = createClackGuidedInput();
    const silent = { write: () => {} };
    const secretStore = createKeyringSecretStore({});
    const handlers = createConfigCliHandlers({
      secretStore,
      prompt: {
        askSecret: () => guided.askInput({ label: "Secret value · <Esc> Back", masked: true }),
      },
      writers: { stdout: silent, stderr: silent },
    });
    // The full-screen OpenTUI config surface is the common path; the clack
    // menu below is the fallback when OpenTUI can't run.
    const host = createProjectConfigTuiHost(secretStore, {
      baseConfigPath: baseConfigPath(),
      projectRoot: process.cwd(),
    });
    try {
      await runConfigTuiScreen({ loadData: host.loadData, applyEffect: host.applyEffect });
      return EXIT_SUCCESS;
    } catch (error) {
      processStderr.write(
        `Config TUI unavailable (${error instanceof Error ? error.message : String(error)}); falling back to the menu.\n`,
      );
    }
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

/** Command shown after an interactive session has restored the terminal. */
export const formatResumeCommand = (sessionId: string): string =>
  `Resume with: glorious --resume ${sessionId}\n`;

export const notifyAvailableUpdate = async (
  check: () => Promise<{ available?: string } | undefined>,
  emit: (event: ChatEvent) => void,
): Promise<void> => {
  try {
    const result = await check();
    if (result?.available)
      emit({
        type: "notice",
        text: `glorious ${result.available} is available. Run /update to install it.`,
      });
  } catch {}
};

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

export { formatChatEvent, truncateLineWithNotice } from "./lib/tui/chat-event-format";
export { composeProgressLines } from "./lib/tui/progress";
export {
  composeStatusSection,
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
  /** The selected terminal renderer (opentui default, ansi opt-out). */
  tuiRenderer: "opentui" | "ansi";
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
  attachInteractiveCapabilities(options: InteractiveCapabilities): void;
  environment: Awaited<ReturnType<typeof createHostExecutionEnvironment>>;
  stateRoot: string;
  /** Discovered Agent Skills and the malformed entries worth surfacing. */
  skills: readonly Skill[];
  skillIssues: readonly SkillIssue[];
  startMcp(): Promise<void>;
  reloadMcp(name?: string): Promise<void>;
  /** A config-TUI host bound to this session's config layers and keychain. */
  createConfigTuiHost(): ConfigTuiHost;
  /** Re-read config from disk and apply what this session can change live:
   *  model routing (tiers/variants/modes), permissions, and MCP servers. */
  reloadSessionConfig(): Promise<void>;
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
  const secretStore = createKeyringSecretStore({});
  const activeProvider = config.agent.llm.provider;
  const providerApiKey = await resolveActiveProviderKey(activeProvider, secretStore, {
    require: true,
  });
  const mcpOAuth = createKeyringMcpOAuthStorage(secretStore);
  // Config-first with the historical env var kept as a fallback enable. The
  // provider is only stood up when an OTLP endpoint is configured; otherwise
  // the sink reads the global meter (an external bootstrap's, or a no-op).
  const metricsEnabled = config.metrics.enabled || process.env.GLORIOUS_OTEL_METRICS === "1";
  const metricsProvider = metricsEnabled ? startMetricsProvider(config.metrics) : undefined;
  const metricsSink: MetricsSink = createOtelMetricsSink({ enabled: metricsEnabled });
  const environment = await createHostExecutionEnvironment(root);
  // Over-cap tool output spills here in full; tools reference the file in
  // their truncation notices so the model can slice it back in.
  const spillSink = createSpillSink(join(tmpdir(), "glorious-spill", entrypoint));
  const spill = { dir: spillSink.dir, write: spillSink.write };
  // Web capabilities are client-side and model-provider independent. Exa only
  // backs the search port; direct URL fetching never flows through an LLM API.
  const web = {
    search: createExaWebSearch({ maxOutputChars: config.agent.tools.maxOutputChars }),
    fetch: createHttpWebFetch(),
  };

  let agentsMd = "";
  try {
    agentsMd = await environment.readFile("AGENTS.md");
  } catch {}
  // Agent Skills (agentskills.io): project skills win over global ones. Their
  // names/descriptions ride the rules so every mode and entrypoint can
  // activate a skill by reading its SKILL.md (progressive disclosure).
  const skillsDiscovery = await discoverSkills({
    roots: [
      join(root, ".glorious", "skills"),
      join(homedir(), ".config", "glorious", "skills"),
      embeddedSkillsRoot,
    ],
  });
  const skillsSection = composeSkillsPromptSection(skillsDiscovery.skills);
  const agentConfig: AgentConfig = {
    ...config.agent,
    rules: [agentsMd, config.agent.rules, skillsSection].filter(Boolean).join("\n\n"),
    llm: withProviderKey(config.agent.llm, activeProvider, providerApiKey),
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

  const agents = new Map<ChatMode, Promise<Agent>>();
  const modelRouting = createAgentModelRouting(agentConfig, () => agents.clear());
  const agentConfigFor = modelRouting.configFor;
  // Research workers are plan-mode children. Each run gets a scoped MCP lease
  // so user-requested research uses the same safe inspection tools.
  const createResearchWorker = async (
    origin?: string,
    workerConfig = childAgentConfig(agentConfigFor("plan"), "delegate"),
  ) => ({
    generate: async (
      prompt: string,
      options?: { abortSignal?: AbortSignal; onStep?: (step: RunStep) => void },
    ) => {
      const externalLease = await mcp.createChildConnection(root, options?.abortSignal);
      try {
        const worker = await createProductionAgent(environment, workerConfig, {
          root,
          ctx,
          metricsSink,
          spill,
          web,
          mode: "plan",
          stopContextTokens: config.agent.context.softLimit,
          childExternalTools: externalLease.externalTools,
          permissions: {
            config: config.permissions,
            gate: origin ? withRequestOrigin(gate, origin) : gate,
          },
        });
        return await worker.generate(prompt, options);
      } finally {
        await externalLease.close();
      }
    },
  });

  const mcp = createMcpRuntime(config.mcp, {
    root,
    connectServer: connectModelContextProtocolServer,
    onStatus: onMcpStatus,
    oauth: mcpOAuth,
    spill: spill.write,
  });
  const loadMcpSessionConfig = async () => {
    const latest = await loadChatConfig(undefined, configLoadOptions);
    return { mcp: latest.config.mcp, issues: latest.mcpIssues };
  };
  const mcpController = createMcpSessionController({
    initial: { mcp: config.mcp, issues: loadedConfig.mcpIssues },
    runtime: mcp,
    load: loadMcpSessionConfig,
    onStatus: onMcpStatus,
    authorizeHttp: async (name, server, hooks) => {
      try {
        return await runMcpOAuthFlow(name, server.url, {
          storage: mcpOAuth,
          headers: resolveMcpTransportConfig(server).headers ?? {},
          ...(hooks?.onAuthorizationUrl ? { onAuthorizationUrl: hooks.onAuthorizationUrl } : {}),
        });
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  let agentMcpVersion = mcp.snapshot().version;
  const interactive = createInteractiveCapabilityBinder();
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
            web,
            mode: "plan",
            externalTools: mcpSnapshot.externalTools,
            research: {
              createWorker: (task) => createResearchWorker(`subagent ${task.id}`),
              onProgress: onDagProgress,
            },
            onToolActivity,
            permissions: { config: config.permissions, gate },
            jobs: interactive.jobs,
            ...(entrypoint === "chat"
              ? { todos: interactive.todos, questions: interactive.questions }
              : {}),
          })
        : createProductionAgent(environment, agentConfigFor("build"), {
            root,
            ctx,
            metricsSink,
            spill,
            web,
            delegation,
            mode: "build",
            externalTools: mcpSnapshot.externalTools,
            createChildExternalTools: (childRoot, signal) =>
              mcp.createChildConnection(childRoot, signal),
            permissions: { config: config.permissions, gate },
            onSubagentProgress: onDagProgress,
            onToolActivity,
            jobs: interactive.jobs,
            ...(entrypoint === "chat"
              ? { todos: interactive.todos, questions: interactive.questions }
              : {}),
          });
    agents.set(mode, agent);
    return agent;
  };

  const runPlanJob = async (
    prompt: string,
    abortSignal: AbortSignal,
    origin = "job",
    onStep?: (step: RunStep) => void,
  ) => {
    const worker = await createResearchWorker(origin);
    const result = await worker.generate(prepareBackgroundJobPrompt(prompt), {
      abortSignal,
      onStep,
    });
    return { text: result.text };
  };

  const runBuildJob = async (
    prompt: string,
    abortSignal: AbortSignal,
    origin = "job",
    onStep?: (step: RunStep) => void,
  ) => {
    const outcome = (await runSubagentTasks(
      {
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
                  web,
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
      },
      {
        tasks: [
          {
            title: prompt.slice(0, 72),
            prompt: prepareBackgroundJobPrompt(prompt),
            waitsOn: [],
          },
        ],
      },
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
      return modelRouting.selections().primary;
    },
    modelSelections: modelRouting.selections,
    configureModel: modelRouting.configure,
    modelFor: (mode: ChatMode) => {
      const active = agentConfigFor(mode).llm;
      return { provider: active.provider, model: active.model };
    },
    contextSoftLimit: config.agent.context.softLimit,
    tuiRenderer: config.tui.renderer,
    evalPrices: config.eval.prices,
    agentFor,
    runBuildJob,
    runPlanJob,
    attachInteractiveCapabilities: interactive.attach,
    environment,
    stateRoot,
    skills: skillsDiscovery.skills,
    skillIssues: skillsDiscovery.issues,
    startMcp: mcpController.start,
    reloadMcp: mcpController.reload,
    createConfigTuiHost: () => createProjectConfigTuiHost(secretStore, configLoadOptions),
    reloadSessionConfig: async () => {
      const latest = await loadChatConfig(undefined, configLoadOptions);
      // Permissions are read live from this object on every tool call, so
      // updating it in place applies Trust changes without a restart.
      config.permissions = latest.config.permissions;
      // Only re-route models when the llm config actually changed — reload clears
      // the agent cache and drops any live `/model` override, so a no-op close
      // must not disturb the session.
      if (JSON.stringify(latest.config.agent.llm) !== JSON.stringify(config.agent.llm)) {
        config.agent.llm = latest.config.agent.llm;
        // The provider may have changed in the editor — re-resolve its key softly
        // (no hard-fail mid-session; the SDK surfaces a clear error if truly absent).
        const nextProvider = latest.config.agent.llm.provider;
        const nextKey = await resolveActiveProviderKey(nextProvider, secretStore);
        modelRouting.reload({
          ...agentConfig,
          llm: withProviderKey(latest.config.agent.llm, nextProvider, nextKey),
        });
      }
      // Reconnecting MCP servers is disruptive, so only reconcile when the mcp
      // config actually changed (add/remove/edit), not on every editor close.
      if (JSON.stringify(latest.config.mcp) !== JSON.stringify(config.mcp)) {
        config.mcp = latest.config.mcp;
        await mcpController.reload();
      }
    },
    authorizeMcp: mcpController.authorize,
    mcpPrompts: () => mcp.prompts(),
    getMcpPrompt: (server, prompt, args) => mcp.getPrompt(server, prompt, args),
    mcpStatuses: mcpController.statuses,
    close: async () => {
      await mcp.close();
      await metricsProvider?.shutdown();
      spillSink.close();
    },
  };
}

/** The interactive chat session (the default command). */
export async function runGloriousChat(
  options: { resume?: string; continueLatest?: boolean } = {},
  configPath: string = new URL("./glorious.ts", import.meta.url).pathname,
  update?: (channel: UpdateChannel) => Promise<void>,
  checkForUpdate?: () => Promise<{ available?: string } | undefined>,
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
  // The VU busy meter animates on its own fast frame so the hum is fluid; the
  // progress spinner and clocks stay on the calmer spinnerFrame.
  let vuFrame = 0;
  const turnTokens = { ctx: 0 };
  let lastContextWarning: number | undefined;
  const activeTools = new Map<number, { tool: string; detail: string; startedAt: number }>();
  let todos: ReturnType<typeof createSessionTodos> | undefined;
  const completedActivities: Array<{ tool: string; detail: string; elapsedMs: number }> = [];

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
      composeProgressLines({
        todos: formatTodoProgressLines(todos?.list() ?? []),
        activeTools,
        dagBlocks: dagBlockLines(),
        queued: queuedLines(),
        spinnerFrame,
      }).map(presentActivityLine),
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
      const detail = started?.detail ?? activity.detail;
      // A tool that owned a subagent DAG freezes its rows beneath the tool line,
      // so the transcript reads parent-then-children.
      const dagBlock =
        dagTrackers.get(activity.id)?.lines(spinnerFrame, dagIndent(activity.id)) ?? [];
      dagTrackers.delete(activity.id);
      completedActivities.push({ tool: activity.tool, detail, elapsedMs });
      if (completedActivities.length > 100) completedActivities.shift();
      turnProducedOutput = true;
      // Stream each finished tool into the transcript so the turn shows what it
      // actually did, rather than collapsing to a single count. Only the ✓ is
      // toned — the row itself stays calm — and any owned DAG rows freeze below.
      if (screen) {
        const row: ToolRow = {
          tool: activity.tool,
          detail,
          elapsedMs,
          outcome: "ok",
          ...(dagBlock.length > 0 ? { dag: dagBlock } : {}),
        };
        screen.printAbove(renderToolRow(row, { live: false }, screen.width()), "none");
      }
    }
    refreshProgress();
    updateStatus();
  };

  // First-run gate: walk the user through setting a provider key before
  // standing up the session, which otherwise hard-errors on a missing key.
  // Interactive TTY only — `glorious run` and pipes keep the clean error.
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
    const persistence = await bootstrapInteractiveSession({
      stateRoot,
      projectRoot: root,
      projectIdentity: commonGitDir,
      environment,
      ...options,
    });
    if (!persistence.ok) {
      processStderr.write(`${persistence.error}\n`);
      return EXIT_FAILURE;
    }
    const { promptHistory, resumed, log, undo: undoStack } = persistence;
    const rememberPrompt = (text: string): void => {
      pendingHistoryWrites = pendingHistoryWrites
        .then(() => promptHistory.append(text))
        .catch((error) => {
          screen?.printAbove(
            `prompt history error: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    };

    resumeSessionId = log.id;
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
        refreshProgress();
        return;
      }
      if (event.type === "context-cleared") {
        usageRows.length = 0;
        turnUsage = null;
        turnTokens.ctx = 0;
        lastContextWarning = undefined;
        turnStartedAt = null;
        interruptRequested = false;
        turnProducedOutput = false;
        completedActivities.length = 0;
        screen?.clearTranscript();
        refreshProgress();
        updateStatus();
        return;
      }
      if (event.type === "turn-usage") {
        turnTokens.ctx = event.usage.inputTokens;
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
      // Chat styling (interactive only): one seam lowers every transcript event
      // to a semantic block + spacing. User and assistant blocks separate with a
      // blank line ("turn"); tool and system lines pack tight ("none"). The
      // empty-response notice fires only when the turn showed nothing at all —
      // otherwise the turn is indistinguishable from a hang.
      const item = toTranscriptItem(event);
      if (item && screen && (item.kind !== "empty" || !turnProducedOutput)) {
        if (item.kind !== "user") turnProducedOutput = true;
        const { block, spacing } = renderTranscriptItem(item, screen.width());
        screen.printAbove(block, spacing);
      }
      updateStatus();
    };
    const orderedEvents = createChatEventOrderer(render);
    emitChatEvent = (event) => orderedEvents.emit(event);
    const emit = (event: ChatEvent): void => emitChatEvent?.(event);

    const guidedInput = {
      askInput: (inputOptions: Parameters<ChatScreen["askInput"]>[0]) =>
        screen?.askInput(inputOptions) ?? Promise.resolve(null),
    };
    const questionPort = createQuestionPort({ guided: guidedInput, onEvent: emit });
    const sessionTodos = createSessionTodos({
      log,
      initial: resumed?.todos,
      onEvent: emit,
    });
    todos = sessionTodos;
    const chat: ChatSession = createChatSession(
      {
        agentFor,
        log,
        undo: undoStack,
        todos: sessionTodos,
        contextSoftLimit: composition.contextSoftLimit,
        onEvent: emit,
      },
      resumed?.state
        ? {
            messages: resumed.state.messages,
            mode: resumed.state.mode,
          }
        : {},
    );

    const jobRunner = createJobRunner({
      onEvent: emit,
      addTurnNotice: (text) => chat.addTurnNotice(text),
      onJobCompleted: (job) => {
        if (job.status !== "aborted") chat.resumePendingWork();
      },
      runJob: ({ id, mode, prompt, abortSignal, onStep }) =>
        mode === "plan"
          ? composition.runPlanJob(prompt, abortSignal, `job ${id}`, onStep)
          : composition.runBuildJob(prompt, abortSignal, `job ${id}`, onStep),
      // The soft-timeout ping rides the normal turn queue: it waits out a busy
      // foreground turn and shows in the transcript only once its turn runs.
      ping: (job) => {
        void chat.send(
          `[system] Background job ${job.id} reached its soft timeout and is still running — prompt: "${job.prompt.slice(0, 80)}". Check it with check_background_job, then renew its soft timeout if it is progressing or abort it if it is stuck.`,
          { transcriptText: `[${job.id}] soft timeout reached — checking on it` },
        );
      },
    });
    jobs = jobRunner;
    composition.attachInteractiveCapabilities({ jobs: jobRunner, todos, questions: questionPort });

    const home = homedir();
    const rootDisplay = root.startsWith(home) ? `~${root.slice(home.length)}` : root;
    updateStatus = (): void => {
      if (!screen) return;
      const busy = chat.busy && !permissionPending;
      const queued = queuedMessages.length;
      const toneControlsLine = (text: string, index: number): UiTextLine => {
        if (index !== 1) return [{ text, tone: "muted" }];
        const segs: UiSpan[] = [{ text, tone: "muted" }];
        if (interruptRequested)
          segs.push({
            text: `   Stopping safely…${queued ? ` · ${queued} queued` : ""}`,
            tone: "warning",
          });
        else if (busy)
          segs.push({ text: `   ${formatVuMeter(vuFrame)}  Esc interrupt`, tone: "accent" });
        return segs;
      };
      const mode = chat.pendingMode;
      screen.setComposer({
        label: `${mode} › `,
        placeholder:
          mode === "plan" ? "Ask a question or describe a change" : "Describe what to build",
      });
      screen.setStatusLines(
        composeStatusSection(
          {
            root: rootDisplay,
            model: (({ provider, model }) => `${provider}/${model}`)(
              composition.modelFor(chat.pendingMode),
            ),
            mode: chat.pendingMode,
            spinnerFrame,
            usage: turnTokens,
            contextSoftLimit: composition.contextSoftLimit,
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
        ).map(toneControlsLine),
      );
    };

    // Animate the busy meter on a fast frame for a fluid hum; advance the
    // calmer spinner/clock frame every third tick. The screen skips repaints
    // when a section is unchanged, so idle ticks cost one comparison.
    let animationTick = 0;
    ticker = setInterval(() => {
      animationTick += 1;
      vuFrame += 1;
      if (animationTick % 3 === 0) {
        spinnerFrame += 1;
        if (dagTrackers.size > 0 || activeTools.size > 0) refreshProgress();
      }
      updateStatus();
    }, 90);

    const configOutput = (message: string): void => {
      const text = message.trim();
      if (text) emit({ type: "notice", text });
    };
    const interactiveConfig = createConfigCliHandlers({
      config: { projectRoot: process.cwd() },
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
      emit,
      quit: () => quitResolve?.(),
      requestUpdate: (channel) => {
        requestedUpdate = channel;
      },
      config: interactiveConfig,
      launchConfigTui: async () => {
        const runModal = screen?.runModalScreen;
        if (!runModal) {
          emit({
            type: "notice",
            text: "Interactive config needs the full-screen renderer; use /config get|set|delete or `glorious config`.",
          });
          return;
        }
        const configHost = composition.createConfigTuiHost();
        await runModal((renderer) =>
          runConfigTuiScreen({
            renderer,
            loadData: configHost.loadData,
            applyEffect: configHost.applyEffect,
          }),
        );
        // Apply anything the editor changed to the running session.
        await composition.reloadSessionConfig();
      },
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
      guided: guidedInput,
      skills: skillCommands,
    };
    const skillNotices = [
      ...composition.skillIssues.map(({ path, detail }) => `skill ${path}: ${detail}`),
      ...skillCommands
        .filter(({ name }) => name in chatCommands)
        .map(({ name }) => `skill ${name} is shadowed by the built-in /${name} command.`),
    ];

    const clipboardAttachments = createCrosscopyClipboardAttachments();
    const pastedImages = createPastedImageRegistry();
    const projectFiles = createProjectFileCatalog(createGitProjectFileSource(environment, root));
    await projectFiles.refresh();
    const sharedScreenOptions = {
      initialHistory: promptHistory.entries,
      matchesSlashCommand: (query: string) =>
        suggestChatInputRoots(query, commandContext).length > 0,
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
      shouldRememberInput: (text: string) =>
        shouldRememberChatInput(text) && !pastedImages.hasReference(text),
      callbacks: {
        onSubmit: (text: string) => {
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
                emit({ type: "notice", text: added.error });
                return null;
              }
              return ` ${added.marker} `;
            }
            emit({
              type: "notice",
              text: "Ctrl+V attaches files copied in your file manager or a copied screenshot — the clipboard has neither right now. To paste text, use your terminal's paste (⌘V).",
            });
            return null;
          } catch (error) {
            emit({
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
    };
    // OpenTUI is the default full-screen surface; `tui.renderer: ansi` (or
    // GLORIOUS_TUI=ansi for a one-off) opts into the live-region renderer.
    const tuiRenderer = process.env.GLORIOUS_TUI ?? composition.tuiRenderer;
    screen =
      tuiRenderer === "ansi"
        ? createChatScreen({
            liveRegion: createAnsiLiveRegionAdapter({ stdout: processStdout }),
            ...sharedScreenOptions,
          })
        : await createOpenTuiChatScreen({ stdout: processStdout, ...sharedScreenOptions });

    screen.start();
    refreshProgress();
    updateStatus();
    if (checkForUpdate) {
      void notifyAvailableUpdate(checkForUpdate, (event) => emitChatEvent?.(event));
    }
    for (const notice of skillNotices) emit({ type: "notice", text: notice });
    for (const turn of (resumed?.turns ?? []).slice(-5)) {
      screen.printAbove(
        formatUserTurnBlock(turn.user, turn.transcriptText, screen.width()),
        "turn",
      );
      screen.printAbove(turn.assistant);
    }
    void composition.startMcp().catch((error) => {
      emit({
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
export async function runGloriousOnce(
  task: string,
  options: { plan: boolean; allowAll: boolean; signal: AbortSignal },
  configPath: string = new URL("./glorious.ts", import.meta.url).pathname,
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
      root: join(composition.stateRoot, "glorious", "chats"),
      projectRoot: composition.root,
      title: task,
    });
    const undo = createUndoStack(composition.environment, composition.root, log.id);

    let outcome: "done" | "aborted" | "error" = "done";
    let resultText = "";
    const turnUsage: UsageRecord["usage"] = {
      inputTokens: 0,
      outputTokens: 0,
      longContextRequests: 0,
    };
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
          if (event.type === "turn-usage") {
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
            if (event.usage.inputTokens > LONG_CONTEXT_INPUT_TOKENS) {
              turnUsage.longContextRequests += 1;
            }
          }
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

    if (turnUsage.inputTokens + turnUsage.outputTokens > 0) {
      const model = composition.modelFor(options.plan ? "plan" : "build");
      await log.append({
        type: "usage",
        provider: model.provider,
        model: model.model,
        ts: new Date().toISOString(),
        usage: turnUsage,
      });
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
      packageName: "@glrs-dev/glorious",
      registry: createNpmRegistryAdapter(),
      ...(installer ? { installer } : {}),
      state: createUpdateStateStore(),
    }),
    supported: installer !== undefined,
    auto: config.update.auto,
  };
};

const runProductionUpdateCheck = async (): Promise<{ available?: string } | undefined> => {
  const { service, supported, auto } = await createProductionUpdateService();
  if (!auto || !supported) return undefined;
  return await service.checkFresh(COMMAND_VERSION);
};

const runProductionUpdate = async (channel: UpdateChannel): Promise<number> => {
  try {
    const { service } = await createProductionUpdateService();
    const result = await service.update(COMMAND_VERSION, channel);
    if (result.available) {
      processStdout.write(`Updated glorious to ${result.available} (${result.channel}).\n`);
    } else {
      processStdout.write(`glorious ${COMMAND_VERSION} is current on ${result.channel}.\n`);
    }
    return EXIT_SUCCESS;
  } catch (error) {
    processStderr.write(
      `Unable to update glorious: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
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
    config: { projectRoot: process.cwd() },
    secretStore: createKeyringSecretStore({}),
    prompt: {
      askSecret: () => guided.askInput({ label: "Secret value · <Esc> Back", masked: true }),
    },
    writers,
  });

  process.on("SIGINT", handleSigint);
  try {
    process.exitCode = await runGloriousCli(
      argv,
      {
        version: COMMAND_VERSION,
        runChat: (options) =>
          runGloriousChat(
            options,
            undefined,
            async (channel) => {
              if ((await runProductionUpdate(channel)) !== EXIT_SUCCESS) {
                throw new Error("Glorious update failed.");
              }
            },
            runProductionUpdateCheck,
          ),
        runOnce: (task, options) => runGloriousOnce(task, options),
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
