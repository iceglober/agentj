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
import { createSearchTools } from "../tools/search";
import { type CreateSubagentToolOptions, createSubagentTool } from "./delegate";

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
  tools: z.object({ edit: editConfigSchema.prefault({}) }).prefault({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export interface CreateAgentDelegationOptions
  extends Pick<CreateSubagentToolOptions, "createChildSession" | "maxConcurrency" | "parentRef"> {}

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
    },
    opts.ctx,
  );

  const fileSandbox = confineSandboxFiles(sb, opts.root);

  const delegationTool: ToolSet = opts.delegation
    ? {
        run_subagents: createSubagentTool({
          parentRef: opts.delegation.parentRef,
          maxConcurrency: opts.delegation.maxConcurrency,
          createChildSession: opts.delegation.createChildSession,
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
              },
            );

            return {
              generate: (prompt, generateOpts) =>
                child.generate(prompt, {
                  abortSignal: generateOpts?.abortSignal,
                }),
            };
          },
        }),
      }
    : {};

  // Search keeps its explicit root resolver on the original sandbox, while both
  // bash-adapter structured file tools and edit tools use a sandbox view whose
  // file reads/writes are lexically confined to opts.root. That preserves the
  // existing tool precedence — editTools still replaces bash-tool's plain readFile
  // with mode-specific line/anchor prefixes — and the same createAgent wiring
  // automatically confines both parent and child agents. Delegation stays last
  // because only the parent opts into it, and no later spread can accidentally
  // overwrite `run_subagents` and silently disable it.
  const tools: ToolSet = {
    ...(await createBashTools(fileSandbox, { root: opts.root })),
    ...createSearchTools(sb, { root: opts.root }),
    ...createEditTools(fileSandbox, config.tools.edit.mode),
    ...delegationTool,
  };

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
