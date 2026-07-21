import type { ConfigCliHandlers } from "../config-cli";
import type { McpPromptCatalogEntry, McpPromptResult } from "../mcp";
import type { McpRuntimeStatus } from "../mcp/runtime";
import type { UndoStack } from "../session/undo";
import type { TodoList } from "../todos";
import type { UpdateChannel } from "../update";
import type { CostPrice, UsageRecord } from "./cost";
import type { ChatEvent } from "./events";
import type { GuidedInputPort } from "./guided-input";
import type { JobRunner } from "./jobs";
import type { ChatSession } from "./session";

/** A discovered Agent Skill surfaced as a slash command. */
export interface SkillCommand {
  name: string;
  summary: string;
  /** Mode to switch to before the skill turn starts (metadata agentj-mode). */
  mode?: "plan" | "build";
  /** The full turn prompt for an explicit invocation with these arguments. */
  prompt(args: string): string;
}

export type ModelTarget = "primary" | "subagents";

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ModelController {
  current(): { primary: ModelSelection; subagents: ModelSelection | null };
  providers(): readonly string[];
  modelSuggestions(provider: string): readonly string[];
  configure(target: ModelTarget, selection: ModelSelection | null): Promise<boolean>;
}

/** Dependencies available to built-in and skill-backed chat commands. */
export interface ChatCommandContext {
  session: ChatSession;
  jobs: JobRunner;
  undo?: UndoStack;
  emit(event: ChatEvent): void;
  /** Ends the interactive session. */
  quit(): void;
  /** Requests a self-update and then allows the caller to exit cleanly. */
  requestUpdate?(channel: UpdateChannel): Promise<void> | void;
  config?: Pick<ConfigCliHandlers, "get" | "set" | "delete">;
  models?: ModelController;
  cost?: {
    rows(): readonly UsageRecord[];
    prices: Readonly<Record<string, CostPrice>>;
  };
  activity?: {
    list(): readonly { tool: string; detail: string; elapsedMs: number }[];
  };
  todos?: {
    list(): TodoList;
  };
  mcp?: {
    statuses(): readonly McpRuntimeStatus[];
    prompts?(): readonly McpPromptCatalogEntry[];
    getPrompt?(
      server: string,
      prompt: string,
      args: Record<string, string>,
    ): Promise<McpPromptResult>;
    reload(name?: string): Promise<void>;
    /** Interactive OAuth flow for an HTTP server (browser round-trip). */
    authorize?(
      name: string,
      hooks?: { onAuthorizationUrl?(url: string): void },
    ): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  guided?: GuidedInputPort;
  skills?: readonly SkillCommand[];
}
