import z from "zod";
import {
  createRuntime,
  llmConfigSchema,
  type RunResult,
  type RunStep,
  type ToolSet,
} from "../llm";
import {
  composePrompt,
  promptConfigSchema,
  type ComposedPrompt,
  type PromptContext,
} from "../prompt";
import type { Sandbox } from "../sandbox";
import { createBashTools } from "../tools/bash";
import { createEditTools, editConfigSchema } from "../tools/edit";
import { createSearchTools } from "../tools/search";

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

export interface CreateAgentOptions {
  /** The session worktree the agent's tools operate in. */
  root: string;
  /** Per-turn environment facts stamped into the prompt footer. */
  ctx: PromptContext;
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
  const runtime = createRuntime(config.llm);

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

  // editTools last: its mode-specific readFile (line/anchor prefixes) replaces
  // bash-tool's plain one, so reads always carry what the edit tool consumes.
  const tools: ToolSet = {
    ...(await createBashTools(sb, { root: opts.root })),
    ...createSearchTools(sb, { root: opts.root }),
    ...createEditTools(sb, config.tools.edit.mode),
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
