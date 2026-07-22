import z from "zod";
import {
  createRuntime,
  type ImageAttachment,
  llmConfigSchema,
  providerNames,
  type RunResult,
  type RunStep,
  resolveTierModel,
  type ToolSet,
} from "../llm";
import { compactModelMessages } from "../llm/continuation";
import type { MetricsSink } from "../metrics";
import {
  type ComposedPrompt,
  composePrompt,
  type PromptContext,
  promptConfigSchema,
} from "../prompt";
import type { Sandbox } from "../sandbox";
import { createBashTools } from "../tools/bash";
import { createEditTools, editConfigSchema } from "../tools/edit";
import { confineSandboxFiles } from "../tools/paths";
import { createReadTools } from "../tools/read";
import { createSearchTools } from "../tools/search";
import { createWebTools, type WebFetch, type WebSearch } from "../tools/web";
import type { SpillWriter } from "../truncation";
import {
  type BackgroundJobPort,
  createBackgroundJobTool,
  createCheckJobTool,
} from "./background-jobs";
import { generateWithGroundedCompletion } from "./completion-grounding";
import { instructionsConfigSchema, loadInstructionExtensions } from "./instructions";
import {
  resolveToolTarget,
  type WithPermissionsOptions,
  withPermissions,
  withRequestOrigin,
} from "./permissions";
import { createQuestionTool, type QuestionPort } from "./questions";
import { createReflectionSelectionTool, reflectionsConfigSchema } from "./reflections";
import {
  type CreateSubagentsToolOptions,
  createRunOneSubagentTool,
  createSubagentsTool,
  type DelegationWiring,
  type NormalizedSubagentTask,
  type SubagentProgressEvent,
  type SubagentRunner,
} from "./subagents";
import { createTodoTool, type TodoPort } from "./todos";

/**
 * The agent owns identity/role/rules and composes the three domain modules the
 * loop needs to think and act: `llm` (which model), `prompt` (how it is told to
 * behave), and `tools` (what it can do). Everything a caller needs to stand up
 * a working agent lives in this one schema, each field defaulted so `{}` is a
 * valid agent.
 */
export const agentConfigSchema = z.object({
  name: z.string().default("agentj"),
  role: z.enum(["primary", "delegate"]).default("primary"),
  /** Project rules ({{PROJECT_RULES}}), composed with AGENTS.md and scoped extensions. */
  rules: z.string().default(""),
  instructions: instructionsConfigSchema,
  /**
   * Per-turn tool-loop ceiling (model round-trips) — runaway protection, not a
   * work budget. Without it the AI SDK's implicit 20-step default silently
   * truncates long build turns. Turns that hit the ceiling surface a notice.
   */
  steps: z.number().int().min(1).default(100),
  /**
   * Context-size ceiling. `softLimit` is the request input-token threshold
   * (e.g. 240_000 to stay under a 272k long-context billing tier); unset →
   * no ceiling. The primary agent warns (`onLimit`); children — who cannot
   * receive warnings — stop their tool loop instead.
   */
  context: z
    .object({
      softLimit: z.number().int().min(1).optional(),
      onLimit: z.enum(["warn"]).default("warn"),
    })
    .prefault({}),
  llm: llmConfigSchema.prefault({}),
  prompt: promptConfigSchema.prefault({}),
  reflections: reflectionsConfigSchema,
  tools: z
    .object({
      /**
       * Final char cap on every tool result returned to the model (including
       * structured and external tool output). Bash/read output and MCP results
       * also apply earlier source-specific caps.
       * Over-cap output spills to a session file when spilling is wired, so
       * the cap bounds context growth without losing data.
       */
      maxOutputChars: z.number().int().min(1_000).max(1_000_000).default(30_000),
      edit: editConfigSchema.prefault({}),
      subagents: z
        .object({
          concurrency: z.number().int().min(1).max(8).default(2),
          /** Explicit provider override for planning workers and build subagents. */
          provider: z.enum(providerNames).optional(),
          /**
           * @deprecated Use `tier` for provider-agnostic routing. This explicit
           * model override wins over `tier` for backward compatibility.
           */
          model: z.string().trim().min(1).optional(),
          /**
           * Ladder tier (index into `llm.tiers`) children run on — the
           * provider-agnostic way to route fan-out work to a cheaper rung.
           * Unset (and no `model`) → children inherit the parent's model.
           */
          tier: z.number().int().min(0).optional(),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export interface CreateAgentDelegationOptions
  extends Pick<DelegationWiring, "createChildSession" | "parentRef" | "prepareBatch"> {
  /** Concurrent children ceiling for one tool invocation. */
  maxConcurrency?: number;
}

export type AgentMode = "plan" | "build";

/** Resolves an external permission target from one model tool call. */
export type ExternalToolPermissionTargetResolver = (input: unknown) => string | undefined;

export interface ExternalAgentTools {
  tools: ToolSet;
  /** External tools omitted from this map remain ungated. */
  permissionTargets?: Readonly<Record<string, ExternalToolPermissionTargetResolver>>;
}

export interface CreateAgentOptions {
  /** The session worktree the agent's tools operate in. */
  root: string;
  /** Per-turn environment facts stamped into the prompt footer. */
  ctx: PromptContext;
  /**
   * Optional parent-only wiring for `run_subagents`. Ordinary callers omit this
   * and get the historical tool set with no delegation support.
   */
  delegation?: CreateAgentDelegationOptions;
  /** Optional content-free telemetry; omitted keeps runtime metrics disabled. */
  metricsSink?: MetricsSink;
  /**
   * Session spill store for over-cap tool output: `write` persists the full
   * value, `dir` becomes an extra readable root so the model can slice the
   * spilled file back in. Omitted → over-cap output is plainly truncated.
   */
  spill?: { dir: string; write: SpillWriter };
  /**
   * Host-first permission gating for the mutating tools. Omitted (sandboxed
   * runs, evals) keeps the historical ungated toolset.
   */
  permissions?: WithPermissionsOptions;
  /**
   * Live execution feedback: fires when a tool actually starts and ends
   * (after any permission grant), so a UI can show what is running now —
   * step-end events alone leave long tool calls invisible.
   */
  onToolActivity?(activity: ToolActivity): void;
  /**
   * Cap the tool loop at N steps. Routed through the runtime port's `stopSteps`
   * so the eval harness can set its per-task step budget once, without the
   * caller knowing how any particular runtime enforces the cap. Omitted → the
   * config's `steps` ceiling stands.
   */
  stopSteps?: number;
  /**
   * Stop the tool loop once a request's context reaches this many input
   * tokens (routed to the runtime port's `stopContextTokens`). Set for
   * children/jobs so fresh contexts respect the session's context ceiling;
   * the interactive primary warns via turn notice instead of stopping.
   */
  stopContextTokens?: number;
  /** Capability mode: plan (read-only tools) or build (full). Default build. */
  mode?: AgentMode;
  /** Compose the reflection prompt variant: first-person prose, read-only, no
   * report schema. */
  reflect?: boolean;
  /** Provider-neutral web search and fetch capabilities supplied by composition. */
  web?: { search: WebSearch; fetch: WebFetch };
  /** Primary-only, mode-specific tools supplied by an external integration. */
  externalTools?: Partial<Record<AgentMode, ExternalAgentTools>>;
  /** Child-specific external tools. The composition root must create these as
   * a scoped lease; children never receive the primary connection directly. */
  childExternalTools?: Partial<Record<AgentMode, ExternalAgentTools>>;
  /** Creates a child-owned external capability lease for a worktree. */
  createChildExternalTools?(
    root: string,
    signal?: AbortSignal,
  ): Promise<{
    externalTools: Record<AgentMode, ExternalAgentTools>;
    close(): Promise<void>;
  }>;
  /** Plan-mode run_subagents wiring: read-only research workers. */
  research?: {
    createWorker(task: NormalizedSubagentTask): Promise<SubagentRunner>;
    onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  };
  /** Build-mode run_subagents progress (worktree children). */
  onSubagentProgress?(event: SubagentProgressEvent): void | Promise<void>;
  /**
   * Primary-only: lets the model detach a task into the session's
   * background-job runner (run_background_job) instead of blocking its turn on it.
   * Delegates and background children never inherit this.
   */
  jobs?: BackgroundJobPort;
  /** Primary interactive-session todo capability; never inherited by children. */
  todos?: TodoPort;
  /** Primary interactive-session question capability; never inherited by children. */
  questions?: QuestionPort;
}

/** Per-turn hooks for a single generate() call. */
export interface GenerateOptions {
  abortSignal?: AbortSignal;
  onStep?: (step: RunStep) => void;
  /** Images sent with this user message. */
  images?: readonly ImageAttachment[];
  /** Prior turns (RunResult.messages) — the chat loop's opaque continuation. */
  messages?: unknown[];
  /** Add the plan-only reflection chooser for this draft exchange. */
  selectReflections?: boolean;
}

export interface Agent {
  /** The composed prompt, so the caller can log which profile/version it got. */
  composed: ComposedPrompt;
  /** Run one turn: prompt in, final text + trajectory + usage out. */
  generate(prompt: string, opts?: GenerateOptions): Promise<RunResult>;
  /** Drop old tool payloads while retaining a bounded textual history and recent turns. */
  compactContinuation?(messages: unknown[]): unknown[];
  /** Reflection IDs available to this primary plan agent. */
  reflectionIds?: readonly string[];
}

/**
 * The model children (subagents / planning workers) run: an explicit
 * `subagents.model` wins, else `subagents.tier` resolved against the ladder,
 * else undefined — inherit the parent's model.
 */
export function subagentModel(config: AgentConfig): string | undefined {
  const { model, tier } = config.tools.subagents;
  if (model) return model;
  return tier === undefined ? undefined : resolveTierModel(config.llm, tier);
}

/**
 * The config a child (subagent / planning worker) runs under: the parent's,
 * with the given role and any configured subagent provider/model overrides.
 */
function routedChildAgentConfig(
  config: AgentConfig,
  role: AgentConfig["role"],
  route: { provider?: AgentConfig["llm"]["provider"]; model?: string },
): AgentConfig {
  return {
    ...config,
    role,
    llm:
      route.provider || route.model
        ? {
            ...config.llm,
            ...(route.provider ? { provider: route.provider } : {}),
            ...(route.model ? { model: route.model } : {}),
          }
        : config.llm,
  };
}

export function childAgentConfig(config: AgentConfig, role: AgentConfig["role"]): AgentConfig {
  return routedChildAgentConfig(config, role, {
    provider: config.tools.subagents.provider,
    model: subagentModel(config),
  });
}

/** Reflection routing wins over subagent routing, then inherits the plan model. */
export function reflectionAgentConfig(config: AgentConfig): AgentConfig {
  const { provider, model, tier, temperature } = config.reflections;
  const routed = routedChildAgentConfig(config, "delegate", {
    provider: provider ?? config.tools.subagents.provider,
    model:
      model ?? (tier === undefined ? subagentModel(config) : resolveTierModel(config.llm, tier)),
  });
  if (temperature === undefined) return routed;
  return { ...routed, llm: { ...routed.llm, temperature } };
}

export function withAgentModelSelection(
  config: AgentConfig,
  target: "primary" | "subagents",
  selection: { provider: AgentConfig["llm"]["provider"]; model: string } | null,
): AgentConfig {
  if (target === "primary") {
    return selection
      ? { ...config, llm: { ...config.llm, provider: selection.provider, model: selection.model } }
      : config;
  }
  return {
    ...config,
    tools: {
      ...config.tools,
      subagents: {
        ...config.tools.subagents,
        provider: selection?.provider,
        model: selection?.model,
      },
    },
  };
}

export interface AgentModelSelection {
  provider: string;
  model: string;
}

/** Owns live model overrides and mode-tier routing for one chat composition. */
export function createAgentModelRouting(
  initialConfig: AgentConfig,
  onChange: () => void = () => {},
): {
  config(): AgentConfig;
  configFor(mode: AgentMode): AgentConfig;
  selections(): { primary: AgentModelSelection; subagents: AgentModelSelection | null };
  configure(target: "primary" | "subagents", selection: AgentModelSelection | null): void;
} {
  let config = initialConfig;
  let primaryOverride = false;

  return {
    config: () => config,
    configFor: (mode) =>
      primaryOverride
        ? config
        : {
            ...config,
            llm: {
              ...config.llm,
              model: resolveTierModel(config.llm, config.llm.modes[mode]),
            },
          },
    selections: () => {
      const child = childAgentConfig(config, "delegate");
      const overridden =
        config.tools.subagents.provider !== undefined ||
        config.tools.subagents.model !== undefined ||
        config.tools.subagents.tier !== undefined;
      return {
        primary: { provider: config.llm.provider, model: config.llm.model },
        subagents: overridden ? { provider: child.llm.provider, model: child.llm.model } : null,
      };
    },
    configure: (target, selection) => {
      config = withAgentModelSelection(
        config,
        target,
        selection
          ? {
              provider: selection.provider as AgentConfig["llm"]["provider"],
              model: selection.model,
            }
          : null,
      );
      if (target === "primary") primaryOverride = selection !== null;
      onChange();
    },
  };
}

export interface ToolActivity {
  /** Pairs a start with its end (parallel calls to the same tool differ). */
  id: number;
  tool: string;
  detail: string;
  phase: "start" | "end";
}

/** Wrap every tool's execute with start/end activity callbacks. The minted id
 *  rides along in execute options as `activityId`, so a tool that emits its own
 *  progress events (run_subagents) can tag them with the owning activity. */
const withToolActivity = (
  tools: ToolSet,
  onActivity: (activity: ToolActivity) => void,
  resolveTarget?: (tool: string, input: unknown) => string | undefined,
): ToolSet => {
  let sequence = 0;
  const wrapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    wrapped[name] = {
      ...def,
      async execute(input, executeOptions) {
        sequence += 1;
        const id = sequence;
        const target = resolveToolTarget(name, input, resolveTarget);
        onActivity({ id, ...target, phase: "start" });
        try {
          return await def.execute(input, { ...(executeOptions as object), activityId: id });
        } finally {
          onActivity({ id, ...target, phase: "end" });
        }
      },
    };
  }
  return wrapped;
};

const mergeExternalTools = (builtIn: ToolSet, external?: ExternalAgentTools): ToolSet => {
  if (!external) return builtIn;
  const collisions = Object.keys(external.tools).filter((name) => Object.hasOwn(builtIn, name));
  if (collisions.length > 0) {
    throw new Error(`External tool name collision: ${collisions.sort().join(", ")}`);
  }
  const unknownTargets = Object.keys(external.permissionTargets ?? {}).filter(
    (name) => !Object.hasOwn(external.tools, name),
  );
  if (unknownTargets.length > 0) {
    throw new Error(`External permission target has no tool: ${unknownTargets.sort().join(", ")}`);
  }
  return { ...builtIn, ...external.tools };
};

/** Assemble the capability boundary independently from model construction. */
export async function createAgentTools(
  sb: Sandbox,
  config: AgentConfig,
  opts: CreateAgentOptions,
): Promise<ToolSet> {
  const fileSandbox = confineSandboxFiles(sb, opts.root);
  // Tier routing: surface the children's model on progress rows only when it
  // differs from the parent's — same model needs no callout.
  const childConfig = childAgentConfig(config, "delegate");
  const childModelLabel =
    childConfig.llm.provider !== config.llm.provider || childConfig.llm.model !== config.llm.model
      ? { model: `${childConfig.llm.provider}/${childConfig.llm.model}` }
      : {};
  const delegationTool: ToolSet = opts.delegation
    ? (() => {
        const subagentOptions: CreateSubagentsToolOptions = {
          execution: {
            kind: "delegation" as const,
            parentRef: opts.delegation.parentRef,
            createChildSession: opts.delegation.createChildSession,
            prepareBatch: opts.delegation.prepareBatch,
            createChildAgent: async ({ task, session, root, abortSignal }) => {
              const externalLease = opts.createChildExternalTools
                ? await opts.createChildExternalTools(root, abortSignal)
                : undefined;
              let child: Agent;
              try {
                child = await createAgent(sb, childAgentConfig(config, "delegate"), {
                  root,
                  ctx: {
                    ...opts.ctx,
                    cwd: root,
                    gitBranch: session.branch,
                    gitStatusSummary: await session.status(),
                  },
                  metricsSink: opts.metricsSink,
                  spill: opts.spill,
                  web: opts.web,
                  stopSteps: opts.stopSteps,
                  stopContextTokens: config.context.softLimit,
                  ...(externalLease
                    ? { childExternalTools: externalLease.externalTools }
                    : opts.childExternalTools
                      ? { childExternalTools: opts.childExternalTools }
                      : {}),
                  // Children answer to the same session gate as the parent —
                  // worktree isolation confines their edits, not their bash.
                  ...(opts.permissions
                    ? {
                        permissions: {
                          ...opts.permissions,
                          gate: withRequestOrigin(opts.permissions.gate, `subagent ${task.id}`),
                        },
                      }
                    : {}),
                });
              } catch (error) {
                await externalLease?.close();
                throw error;
              }
              return {
                generate: async (prompt, generateOpts) => {
                  try {
                    return await child.generate(prompt, {
                      abortSignal: generateOpts?.abortSignal,
                      onStep: generateOpts?.onStep,
                    });
                  } finally {
                    await externalLease?.close();
                  }
                },
              };
            },
          },
          concurrency: opts.delegation.maxConcurrency,
          ...childModelLabel,
          onProgress: opts.onSubagentProgress,
        };
        return {
          run_one_subagent: createRunOneSubagentTool(subagentOptions),
          run_subagents: createSubagentsTool(subagentOptions),
        };
      })()
    : {};

  const mode = opts.mode ?? "build";
  const external =
    config.role === "primary" ? opts.externalTools?.[mode] : opts.childExternalTools?.[mode];
  const finalize = (builtIn: ToolSet): ToolSet => {
    const merged = mergeExternalTools(builtIn, external);
    const resolveExternalTarget = external?.permissionTargets
      ? (tool: string, input: unknown) => external.permissionTargets?.[tool]?.(input)
      : undefined;
    const active = opts.onToolActivity
      ? withToolActivity(merged, opts.onToolActivity, resolveExternalTarget)
      : merged;
    if (!opts.permissions) return active;
    return withPermissions(active, {
      ...opts.permissions,
      ...(resolveExternalTarget ? { resolveTarget: resolveExternalTarget } : {}),
    });
  };

  const primarySessionTools: ToolSet =
    config.role === "primary"
      ? {
          ...(opts.jobs
            ? {
                run_background_job: createBackgroundJobTool(opts.jobs, mode),
                check_background_job: createCheckJobTool(opts.jobs),
              }
            : {}),
          ...(opts.todos ? { update_todos: createTodoTool(opts.todos) } : {}),
          ...(opts.questions ? { ask_user: createQuestionTool(opts.questions) } : {}),
        }
      : {};
  const webTools: ToolSet = opts.web
    ? createWebTools({
        ...opts.web,
        maxOutputChars: config.tools.maxOutputChars,
        spill: opts.spill?.write,
      })
    : {};

  if (mode === "plan") {
    // Plan agents observe but never edit: of the bash-tool trio they get only
    // `bash` (no writeFile), so they can inspect VCS/CI/build state and run
    // checks. The prompt scopes it to non-mutating commands; the same
    // permission policy as build gates each command.
    const { bash } = await createBashTools(fileSandbox, {
      root: opts.root,
      maxOutputChars: config.tools.maxOutputChars,
      spill: opts.spill?.write,
    });
    return finalize({
      ...(bash ? { bash } : {}),
      // The raw sandbox, not the confined one: the read tool does its own
      // root-confined resolution, extended with the spill dir.
      ...createReadTools(sb, {
        root: opts.root,
        maxOutputChars: config.tools.maxOutputChars,
        ...(opts.spill ? { extraRoots: [opts.spill.dir] } : {}),
      }),
      ...createSearchTools(sb, { root: opts.root }),
      ...webTools,
      ...primarySessionTools,
      ...(opts.research
        ? (() => {
            const subagentOptions: CreateSubagentsToolOptions = {
              execution: { kind: "research", createWorker: opts.research.createWorker },
              concurrency: config.tools.subagents.concurrency,
              ...childModelLabel,
              onProgress: opts.research.onProgress,
            };
            return {
              run_one_subagent: createRunOneSubagentTool(subagentOptions),
              run_subagents: createSubagentsTool(subagentOptions),
            };
          })()
        : {}),
    });
  }

  return finalize({
    ...(await createBashTools(fileSandbox, {
      root: opts.root,
      maxOutputChars: config.tools.maxOutputChars,
      spill: opts.spill?.write,
    })),
    ...createSearchTools(sb, { root: opts.root }),
    ...webTools,
    ...createEditTools(fileSandbox, config.tools.edit.mode),
    ...delegationTool,
    ...primarySessionTools,
  });
}

/**
 * Build a ready-to-run agent from config: pick the runtime, compose the system
 * prompt for that model, and wire the tools against the sandbox. Returns a
 * `generate` closure plus the ComposedPrompt.
 *
 * Explicit `llm.temperature`/`llm.topP` win over the profile's recommendation;
 * otherwise the profile's advised params (and providerOptions) flow through to
 * every generate() call.
 */
function composeInstructionRules(base: string, extensions: string): string {
  return [base, extensions]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function createAgent(
  sb: Sandbox,
  config: AgentConfig,
  opts: CreateAgentOptions,
): Promise<Agent> {
  const runtime = createRuntime(config.llm, opts.metricsSink);

  const composed = composePrompt(
    config.prompt,
    {
      model: config.llm.model,
      agentName: config.name,
      role: config.role,
      rules: composeInstructionRules(
        config.rules,
        await loadInstructionExtensions(sb, config.instructions.extensions, {
          mode: opts.mode ?? "build",
          role: config.role,
        }),
      ),
      mode: opts.mode ?? "build",
      reflect: opts.reflect,
    },
    opts.ctx,
  );

  const tools = await createAgentTools(sb, config, opts);
  const reflectionIds = Object.keys(config.reflections.prompts);
  const reflectionSelectionTool =
    config.role === "primary" && opts.mode === "plan" && reflectionIds.length > 0
      ? createReflectionSelectionTool(config.reflections.prompts)
      : null;

  return {
    composed,
    compactContinuation: compactModelMessages,
    reflectionIds,
    generate: (prompt, generateOpts) => {
      if (generateOpts?.images && generateOpts.images.length > 0 && !composed.supportsImages) {
        return Promise.reject(
          new Error(`The selected model (${config.llm.model}) does not support image input.`),
        );
      }
      const requestTools =
        generateOpts?.selectReflections && reflectionSelectionTool
          ? (() => {
              if (Object.hasOwn(tools, "select_reflections"))
                throw new Error("Reflection selection tool name collides with an existing tool.");
              return { ...tools, select_reflections: reflectionSelectionTool };
            })()
          : tools;
      const request = {
        instructions: composed.instructions,
        prompt,
        images: generateOpts?.images,
        messages: generateOpts?.messages,
        tools: requestTools,
        maxOutputChars: config.tools.maxOutputChars,
        spill: opts.spill?.write,
        temperature: config.llm.temperature ?? composed.params.temperature,
        topP: config.llm.topP ?? composed.params.topP,
        providerOptions: composed.params.providerOptions,
        stopSteps: opts.stopSteps ?? config.steps,
        stopContextTokens: opts.stopContextTokens,
        abortSignal: generateOpts?.abortSignal,
        onStep: generateOpts?.onStep,
      };
      // Reflection workers produce first-person prose, never a completion report
      // or a background job — the grounding gate's done/deferred-work correctives
      // don't apply and would otherwise overwrite a reflection with a blocked
      // report. Go straight to the runtime for them.
      return opts.reflect
        ? runtime.generate(request)
        : generateWithGroundedCompletion(runtime, request, { todos: opts.todos });
    },
  };
}
