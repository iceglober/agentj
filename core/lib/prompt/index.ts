import { createHash } from "node:crypto";
import z from "zod";
import { BASE_TEMPLATE } from "./base";
import {
  type ModelParams,
  type Profile,
  type ProfileName,
  profileNames,
  profiles,
  resolveProfile,
} from "./profiles";
import { renderTemplate } from "./render";

export type { ModelParams, Profile, ProfileName };
export { profileNames, profiles, resolveProfile };

/** Flags a consumer may pin per-agent (the subtractive/additive prose gates). */
export type PromptFlags = {
  planning: boolean;
  smallModel: boolean;
  hallucinationGuard: boolean;
  subagentContract: boolean;
};

/** The full flag set the renderer sees; the two workflow flags are chosen by
 *  profile, not by the user, so they sit outside PromptFlags. */
export type RenderFlags = PromptFlags & {
  workflowSteps: boolean;
  workflowOutcome: boolean;
};

/**
 * The `prompt.*` section of the agent config. `profile: "auto"` resolves from
 * the model id; the optional `flags` block lets a user pin any PromptFlag,
 * overriding whatever the resolved profile set.
 */
export const promptConfigSchema = z.object({
  profile: z.union([z.literal("auto"), z.enum(profileNames)]).default("auto"),
  flags: z
    .object({
      planning: z.boolean().optional(),
      smallModel: z.boolean().optional(),
      hallucinationGuard: z.boolean().optional(),
      subagentContract: z.boolean().optional(),
    })
    .optional(),
});

export type PromptConfig = z.infer<typeof promptConfigSchema>;

/** Per-session facts stamped into the prompt's `# Environment` footer. Kept
 *  separate from PromptInputs because only these vary turn to turn. */
export interface PromptContext {
  cwd: string;
  os: string;
  date: string;
  gitBranch: string;
  gitStatusSummary: string;
}

/** Session-stable inputs a caller (a future `agent` module) supplies. */
export interface PromptInputs {
  model: string;
  agentName: string;
  role: "primary" | "delegate";
  /** Capability mode: plan (read-only) or build (full). Default build. */
  mode?: "plan" | "build";
  rules: string;
  /** Fills SUBAGENT_CONTRACT's {{OUTPUT_SCHEMA}}; used by a future orchestrator. */
  outputSchema?: string;
}

export interface ComposedPrompt {
  instructions: string;
  params: ModelParams;
  profile: ProfileName | "default";
  flags: RenderFlags;
  /** Whether the selected profile accepts image inputs. */
  supportsImages: boolean;
  /** 12-char sha256 of instructions + "\0" + JSON(params). Cache/version key. */
  version: string;
}

/** Neutral fallback when no profile matches: default workflow, everything else
 *  off. */
const DEFAULT_FLAGS: RenderFlags = {
  planning: false,
  smallModel: false,
  hallucinationGuard: false,
  subagentContract: false,
  workflowSteps: true,
  workflowOutcome: false,
};

const DEFAULT_OUTPUT_SCHEMA = "{status, changes[], evidence[], open_questions[]}";

/**
 * Assemble the system prompt. Pure — no IO. Resolution order:
 *   1. Pick the profile ("auto" → resolveProfile, else the named one; a miss
 *      yields the neutral default with no delta and empty params).
 *   2. Merge flags: DEFAULT_FLAGS ← profile.flags ← defined-only config.flags.
 *   3. Pick the template: build mode picks standalone (delegate) or primary
 *      overrides when the profile defines them; plan mode always uses base.
 *   4. Render, then hash instructions+params for the version key.
 */
export function composePrompt(
  config: PromptConfig,
  inputs: PromptInputs,
  ctx: PromptContext,
): ComposedPrompt {
  const profileName = config.profile === "auto" ? resolveProfile(inputs.model) : config.profile;
  const profile: Profile | null = profileName ? profiles[profileName] : null;

  const flags: RenderFlags = { ...DEFAULT_FLAGS, ...(profile?.flags ?? {}) };
  // Only user-defined flag keys override — undefined means "leave as profile".
  for (const [key, value] of Object.entries(config.flags ?? {})) {
    if (value !== undefined) flags[key as keyof PromptFlags] = value;
  }

  const isBuild = (inputs.mode ?? "build") === "build";
  const template =
    inputs.role === "delegate" && isBuild && profile?.standalone
      ? profile.standalone
      : isBuild && profile?.primary
        ? profile.primary
        : BASE_TEMPLATE;

  const vars: Record<string, string> = {
    AGENT_NAME: inputs.agentName,
    PROFILE_DELTA: profile?.delta ?? "",
    PROJECT_RULES: inputs.rules,
    OUTPUT_SCHEMA: inputs.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
    CWD: ctx.cwd,
    OS: ctx.os,
    DATE: ctx.date,
    GIT_BRANCH: ctx.gitBranch,
    GIT_STATUS_SUMMARY: ctx.gitStatusSummary,
  };

  // Template flags are UPPER_SNAKE; map the camelCase RenderFlags across.
  const templateFlags: Record<string, boolean> = {
    WORKFLOW_STEPS: flags.workflowSteps && isBuild,
    WORKFLOW_OUTCOME: flags.workflowOutcome && isBuild,
    PLANNING: flags.planning,
    SMALL_MODEL: flags.smallModel,
    HALLUCINATION_GUARD: flags.hallucinationGuard,
    SUBAGENT_CONTRACT: flags.subagentContract,
    PLAN: !isBuild && inputs.role === "primary",
    RESEARCH: !isBuild && inputs.role === "delegate",
    BUILDER: isBuild,
  };

  const instructions = renderTemplate(template, vars, templateFlags);
  const params: ModelParams = profile?.params ?? {};

  // Version identifies the prompt CONTENT (template + flags + delta + rules +
  // params), not the trial: the volatile `# Environment` footer is excluded so
  // eval results can group trials by prompt across sessions and workdirs.
  const stable = instructions.split("\n# Environment")[0] ?? instructions;
  const version = createHash("sha256")
    .update(`${stable}\0${JSON.stringify(params)}`)
    .digest("hex")
    .slice(0, 12);

  return {
    instructions,
    params,
    profile: profileName ?? "default",
    flags,
    supportsImages: profile?.supportsImages !== false,
    version,
  };
}
