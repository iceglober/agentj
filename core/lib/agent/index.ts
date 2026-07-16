import z from "zod";
import { createRuntime, llmConfigSchema, type RunResult, type RunStep, type ToolSet } from "../llm";
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
import { type WithPermissionsOptions, withPermissions } from "./permissions";
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
  llm: llmConfigSchema.prefault({}),
  prompt: promptConfigSchema.prefault({}),
  tools: z
    .object({
      edit: editConfigSchema.prefault({}),
      subagents: z
        .object({
          concurrency: z.number().int().min(1).max(8).default(2),
          /**
           * Tier routing: when set, planning workers and build subagents run
           * this model instead of the parent's (e.g. a high-volume tier for
           * fan-out work). The prompt profile re-resolves from the child
           * model, so its own template/params apply.
           */
          model: z.string().optional(),
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
   * Host-first permission gating for the mutating tools. Omitted (sandboxed
   * runs, evals) keeps the historical ungated toolset.
   */
  permissions?: WithPermissionsOptions;
  /**
   * Cap the tool loop at N steps. Routed through the runtime port's `stopSteps`
   * so the eval harness can set its per-task step budget once, without the
   * caller knowing how any particular runtime enforces the cap. Omitted → the
   * runtime's default stands.
   */
  stopSteps?: number;
  /** Capability mode: plan (read-only tools) or build (full). Default build. */
  mode?: "plan" | "build";
  /** Plan-mode run_subagents wiring: read-only research workers. */
  research?: {
    createWorker(task: NormalizedSubagentTask): Promise<SubagentRunner>;
    onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  };
  /** Build-mode run_subagents progress (worktree children). */
  onSubagentProgress?(event: SubagentProgressEvent): void | Promise<void>;
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
}

/**
 * The config a child (subagent / planning worker) runs under: the parent's,
 * with the given role and — when tier routing is configured — the subagent
 * model swapped in.
 */
export function childAgentConfig(config: AgentConfig, role: AgentConfig["role"]): AgentConfig {
  const model = config.tools.subagents.model;
  return {
    ...config,
    role,
    llm: model ? { ...config.llm, model } : config.llm,
  };
}

/** Assemble the capability boundary independently from model construction. */
export async function createAgentTools(
  sb: Sandbox,
  config: AgentConfig,
  opts: CreateAgentOptions,
): Promise<ToolSet> {
  const fileSandbox = confineSandboxFiles(sb, opts.root);
  const delegationTool: ToolSet = opts.delegation
    ? {
        run_subagents: createSubagentsTool({
          execution: {
            kind: "delegation",
            parentRef: opts.delegation.parentRef,
            createChildSession: opts.delegation.createChildSession,
            prepareBatch: opts.delegation.prepareBatch,
            createChildAgent: async ({ session, root }) => {
              const child = await createAgent(sb, childAgentConfig(config, "delegate"), {
                root,
                ctx: {
                  ...opts.ctx,
                  cwd: root,
                  gitBranch: session.branch,
                  gitStatusSummary: await session.status(),
                },
                metricsSink: opts.metricsSink,
                stopSteps: opts.stopSteps,
              });
              return {
                generate: (prompt, generateOpts) =>
                  child.generate(prompt, { abortSignal: generateOpts?.abortSignal }),
              };
            },
          },
          concurrency: opts.delegation.maxConcurrency,
          onProgress: opts.onSubagentProgress,
        }),
      }
    : {};

  if ((opts.mode ?? "build") === "plan") {
    return {
      ...createReadTools(fileSandbox, { root: opts.root }),
      ...createSearchTools(sb, { root: opts.root }),
      ...(opts.research
        ? {
            run_subagents: createSubagentsTool({
              execution: { kind: "research", createWorker: opts.research.createWorker },
              concurrency: config.tools.subagents.concurrency,
              onProgress: opts.research.onProgress,
            }),
          }
        : {}),
    };
  }

  const builderTools: ToolSet = {
    ...(await createBashTools(fileSandbox, { root: opts.root })),
    ...createSearchTools(sb, { root: opts.root }),
    ...createEditTools(fileSandbox, config.tools.edit.mode),
    ...delegationTool,
  };
  return opts.permissions ? withPermissions(builderTools, opts.permissions) : builderTools;
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
    generate: (prompt, generateOpts) =>
      runtime.generate({
        instructions: composed.instructions,
        prompt,
        messages: generateOpts?.messages,
        tools,
        temperature: config.llm.temperature ?? composed.params.temperature,
        topP: config.llm.topP ?? composed.params.topP,
        providerOptions: composed.params.providerOptions,
        stopSteps: opts.stopSteps,
        abortSignal: generateOpts?.abortSignal,
        onStep: generateOpts?.onStep,
      }),
  };
}
