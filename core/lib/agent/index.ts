import { ToolLoopAgent, stepCountIs } from "ai";
import { createBashTool } from "bash-tool";
import z from "zod";
import { createModel, llmConfigSchema } from "../llm";
import {
  composePrompt,
  promptConfigSchema,
  type ComposedPrompt,
  type PromptContext,
} from "../prompt";
import type { Sandbox } from "../sandbox";
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
   * Cap the tool loop at N steps. `stopWhen` is a ToolLoopAgent *constructor*
   * setting in ai@7 (not a generate() option), so the eval harness routes its
   * per-task step budget through here rather than re-assembling the agent.
   * Omitted → the ai default (isStepCount(20)) stands.
   */
  stopSteps?: number;
}

/**
 * Build a ready-to-run agent from config: pick the model, compose the system
 * prompt for that model, and wire the tools against the sandbox. Returns the
 * agent plus the ComposedPrompt so the caller can log/inspect which profile
 * and version it got.
 *
 * The ToolLoopAgent constructor (ai@7) extends LanguageModelCallOptions, so
 * `temperature`, `topP`, and `providerOptions` are accepted directly at
 * construction — no need to route them through the generate() call.
 */
export async function createAgent(
  sb: Sandbox,
  config: AgentConfig,
  opts: CreateAgentOptions,
): Promise<{ agent: ToolLoopAgent; composed: ComposedPrompt }> {
  const model = createModel(config.llm);

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

  const { tools: bashTools } = await createBashTool({
    sandbox: sb,
    destination: opts.root,
  });

  // editTools last: its mode-specific readFile (line/anchor prefixes) replaces
  // bash-tool's plain one, so reads always carry what the edit tool consumes.
  const agent = new ToolLoopAgent({
    model,
    instructions: composed.instructions,
    // Explicit llm config wins over the profile's recommendation; fall back to
    // whatever the profile advised for this model.
    temperature: config.llm.temperature ?? composed.params.temperature,
    topP: config.llm.topP ?? composed.params.topP,
    providerOptions: composed.params.providerOptions,
    ...(opts.stopSteps !== undefined ? { stopWhen: stepCountIs(opts.stopSteps) } : {}),
    tools: {
      ...bashTools,
      ...createSearchTools(sb, { root: opts.root }),
      ...createEditTools(sb, config.tools.edit.mode),
    },
  });

  return { agent, composed };
}
