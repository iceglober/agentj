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
import { type CreateSubagentToolOptions, createSubagentTool } from "./delegate";
import {
  createPlanningDagTool,
  type PlanningDagProgressEvent,
  type PlanningTask,
  type PlanningWorker,
} from "./planning-delegate";

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
      subagents: z.object({ concurrency: z.number().int().min(1).max(8).default(2) }).prefault({}),
    })
    .prefault({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export interface CreateAgentDelegationOptions
  extends Pick<
    CreateSubagentToolOptions,
    "createChildSession" | "maxConcurrency" | "parentRef" | "prepareBatch"
  > {}

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
   * Cap the tool loop at N steps. Routed through the runtime port's `stopSteps`
   * so the eval harness can set its per-task step budget once, without the
   * caller knowing how any particular runtime enforces the cap. Omitted → the
   * runtime's default stands.
   */
  stopSteps?: number;
  purpose?: "planner" | "planning-worker" | "builder";
  planning?: {
    createWorker(task: PlanningTask): Promise<PlanningWorker>;
    onProgress?(event: PlanningDagProgressEvent): void | Promise<void>;
  };
}

/** Per-turn hooks for a single generate() call. */
export interface GenerateOptions {
  abortSignal?: AbortSignal;
  onStep?: (step: RunStep) => void;
}

export interface Agent {
  /** The composed prompt, so the caller can log which profile/version it got. */
  composed: ComposedPrompt;
  /** Run one turn: prompt in, final text + trajectory + usage out. */
  generate(prompt: string, opts?: GenerateOptions): Promise<RunResult>;
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
        run_subagents: createSubagentTool({
          parentRef: opts.delegation.parentRef,
          maxConcurrency: opts.delegation.maxConcurrency,
          createChildSession: opts.delegation.createChildSession,
          prepareBatch: opts.delegation.prepareBatch,
          createChildAgent: async ({ root, session, role }) => {
            const child = await createAgent(
              sb,
              { ...config, role },
              {
                root,
                ctx: {
                  ...opts.ctx,
                  cwd: root,
                  gitBranch: session.branch,
                  gitStatusSummary: await session.status(),
                },
                metricsSink: opts.metricsSink,
                stopSteps: opts.stopSteps,
                purpose: "builder",
              },
            );
            return {
              generate: (prompt, generateOpts) =>
                child.generate(prompt, { abortSignal: generateOpts?.abortSignal }),
            };
          },
        }),
      }
    : {};

  const purpose = opts.purpose ?? "builder";
  if (purpose !== "builder") {
    return {
      ...createReadTools(fileSandbox, { root: opts.root }),
      ...createSearchTools(sb, { root: opts.root }),
      ...(purpose === "planner" && opts.planning
        ? {
            run_subagents: createPlanningDagTool({
              concurrency: config.tools.subagents.concurrency,
              createWorker: opts.planning.createWorker,
              onProgress: opts.planning.onProgress,
            }),
          }
        : {}),
    };
  }

  return {
    ...(await createBashTools(fileSandbox, { root: opts.root })),
    ...createSearchTools(sb, { root: opts.root }),
    ...createEditTools(fileSandbox, config.tools.edit.mode),
    ...delegationTool,
  };
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
      purpose: opts.purpose ?? "builder",
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
