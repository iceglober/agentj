import z from "zod";
import {
  createRuntime,
  llmConfigSchema,
  providerNames,
  type RunResult,
  type RunStep,
  resolveTierModel,
  type ToolSet,
} from "../llm";
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
import type { SpillWriter } from "../truncation";
import {
  type BackgroundJobPort,
  createBackgroundJobTool,
  createCheckJobTool,
} from "./background-jobs";
import {
  resolveToolTarget,
  type WithPermissionsOptions,
  withPermissions,
  withRequestOrigin,
} from "./permissions";
import {
  createSubagentsTool,
  type DelegationWiring,
  type NormalizedSubagentTask,
  type SubagentProgressEvent,
  type SubagentRunner,
} from "./subagents";

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
  /** Project rules ({{PROJECT_RULES}}); the composition root may merge in
   *  AGENTS.md read from the sandbox repo (explicit config wins). */
  rules: z.string().default(""),
  /**
   * Per-turn tool-loop ceiling (model round-trips) — runaway protection, not a
   * work budget. Without it the AI SDK's implicit 20-step default silently
   * truncates long build turns. Turns that hit the ceiling surface a notice.
   */
  steps: z.number().int().min(1).default(100),
  /**
   * Context-size ceiling. `softLimit` is the request input-token threshold
   * (e.g. 240_000 to stay under a 272k long-context billing tier); unset →
   * no ceiling. The primary agent warns or compacts (`onLimit`); children —
   * who cannot receive warnings — stop their tool loop instead.
   */
  context: z
    .object({
      softLimit: z.number().int().min(1).optional(),
      onLimit: z.enum(["warn", "compact"]).default("warn"),
    })
    .prefault({}),
  llm: llmConfigSchema.prefault({}),
  prompt: promptConfigSchema.prefault({}),
  tools: z
    .object({
      /**
       * Char cap on bash stdout/stderr and readFile content returned to the
       * model (MCP results have their own `mcp.maxOutputChars`, same default).
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
  /**
   * Primary-only, mode-specific tools supplied by an external integration such
   * as MCP. Delegates and background children never inherit these capabilities.
   */
  externalTools?: Partial<Record<AgentMode, ExternalAgentTools>>;
  /** Plan-mode run_subagents wiring: read-only research workers. */
  research?: {
    createWorker(task: NormalizedSubagentTask): Promise<SubagentRunner>;
    onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  };
  /** Build-mode run_subagents progress (worktree children). */
  onSubagentProgress?(event: SubagentProgressEvent): void | Promise<void>;
  /**
   * Primary-only: lets the model detach a task into the session's
   * background-job runner (run_job) instead of blocking its turn on it.
   * Delegates and background children never inherit this.
   */
  jobs?: BackgroundJobPort;
}

/** Per-turn hooks for a single generate() call. */
export interface GenerateOptions {
  abortSignal?: AbortSignal;
  onStep?: (step: RunStep) => void;
  /** Prior turns (RunResult.messages) — the chat loop's opaque continuation. */
  messages?: unknown[];
}

export interface Agent {
  /** The composed prompt, so the caller can log which profile/version it got. */
  composed: ComposedPrompt;
  /** Run one turn: prompt in, final text + trajectory + usage out. */
  generate(prompt: string, opts?: GenerateOptions): Promise<RunResult>;
  /**
   * Replace this adapter's opaque continuation with a fresh summarized one.
   * Optional so lightweight test/eval agents need only implement generation.
   */
  compact?(messages: unknown[]): Promise<unknown[]>;
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
export function childAgentConfig(config: AgentConfig, role: AgentConfig["role"]): AgentConfig {
  const { provider } = config.tools.subagents;
  const model = subagentModel(config);
  return {
    ...config,
    role,
    llm:
      provider || model
        ? { ...config.llm, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
        : config.llm,
  };
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
    ? {
        run_subagents: createSubagentsTool({
          execution: {
            kind: "delegation",
            parentRef: opts.delegation.parentRef,
            createChildSession: opts.delegation.createChildSession,
            prepareBatch: opts.delegation.prepareBatch,
            createChildAgent: async ({ task, session, root }) => {
              const child = await createAgent(sb, childAgentConfig(config, "delegate"), {
                root,
                ctx: {
                  ...opts.ctx,
                  cwd: root,
                  gitBranch: session.branch,
                  gitStatusSummary: await session.status(),
                },
                metricsSink: opts.metricsSink,
                spill: opts.spill,
                stopSteps: opts.stopSteps,
                stopContextTokens: config.context.softLimit,
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
              return {
                generate: (prompt, generateOpts) =>
                  child.generate(prompt, {
                    abortSignal: generateOpts?.abortSignal,
                    onStep: generateOpts?.onStep,
                  }),
              };
            },
          },
          concurrency: opts.delegation.maxConcurrency,
          ...childModelLabel,
          onProgress: opts.onSubagentProgress,
        }),
      }
    : {};

  const mode = opts.mode ?? "build";
  const external = config.role === "primary" ? opts.externalTools?.[mode] : undefined;
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

  const jobsTool: ToolSet =
    config.role === "primary" && opts.jobs
      ? {
          run_job: createBackgroundJobTool(opts.jobs, mode),
          check_job: createCheckJobTool(opts.jobs),
        }
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
      ...jobsTool,
      ...(opts.research
        ? {
            run_subagents: createSubagentsTool({
              execution: { kind: "research", createWorker: opts.research.createWorker },
              concurrency: config.tools.subagents.concurrency,
              ...childModelLabel,
              onProgress: opts.research.onProgress,
            }),
          }
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
    ...createEditTools(fileSandbox, config.tools.edit.mode),
    ...delegationTool,
    ...jobsTool,
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
export async function createAgent(
  sb: Sandbox,
  config: AgentConfig,
  opts: CreateAgentOptions,
): Promise<Agent> {
  const runtime = createRuntime(config.llm, opts.metricsSink);
  // Compaction is a child-style task, so it deliberately follows the same
  // provider/model/tier routing as subagents rather than consuming the primary
  // model's tier.
  const compactor = createRuntime(childAgentConfig(config, "delegate").llm, opts.metricsSink);

  const composed = composePrompt(
    config.prompt,
    {
      model: config.llm.model,
      agentName: config.name,
      role: config.role,
      rules: config.rules,
      mode: opts.mode ?? "build",
    },
    opts.ctx,
  );

  const tools = await createAgentTools(sb, config, opts);

  return {
    composed,
    compact: (messages) => compactor.compact(messages),
    generate: (prompt, generateOpts) =>
      runtime.generate({
        instructions: composed.instructions,
        prompt,
        messages: generateOpts?.messages,
        tools,
        temperature: config.llm.temperature ?? composed.params.temperature,
        topP: config.llm.topP ?? composed.params.topP,
        providerOptions: composed.params.providerOptions,
        stopSteps: opts.stopSteps ?? config.steps,
        stopContextTokens: opts.stopContextTokens,
        abortSignal: generateOpts?.abortSignal,
        onStep: generateOpts?.onStep,
      }),
  };
}
