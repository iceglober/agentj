import { type ConfigCliHandlers, type ConfigCliResult, listConfigPaths } from "../config-cli";
import { providerNames } from "../llm";
import {
  type McpPromptCatalogEntry,
  type McpPromptResult,
  mcpServerConfigSchema,
  renderMcpPrompt,
} from "../mcp";
import type { McpRuntimeStatus } from "../mcp/runtime";
import type { UndoStack } from "../session/undo";
import type { UpdateChannel } from "../update";
import { type CostPrice, formatCostReport, type UsageRecord } from "./cost";
import type { ChatEvent } from "./events";
import type { GuidedInputPort } from "./guided-input";
import type { JobRunner } from "./jobs";
import type { ChatSession } from "./session";

/**
 * Input routing for the chat screen: slash commands (handled locally, never
 * sent to the model), `&`-prefixed background jobs, and ordinary messages.
 * Commands live in a keyed registry (the checkGraders/editModes idiom) so
 * custom commands have an obvious extension point later.
 */

export type ParsedInput =
  | { kind: "command"; name: string; args: string }
  | { kind: "job"; prompt: string }
  | { kind: "message"; text: string };

export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (text.startsWith("/")) {
    const match = text.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/u);
    return {
      kind: "command",
      name: (match?.[1] ?? "").toLowerCase(),
      args: match?.[2] ?? "",
    };
  }
  if (text.startsWith("&")) return { kind: "job", prompt: text.slice(1).trim() };
  return { kind: "message", text };
}

/**
 * A discovered Agent Skill surfaced as a slash command (the composition root
 * adapts core/lib/skills discoveries into these). Built-in commands win name
 * collisions everywhere skills appear.
 */
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

export interface ChatCommandContext {
  session: ChatSession;
  jobs: JobRunner;
  undo?: UndoStack;
  emit(event: ChatEvent): void;
  /** Ends the interactive session. */
  quit(): void;
  /** Requests a self-update and then allows the caller to exit cleanly. */
  requestUpdate?(channel: UpdateChannel): Promise<void> | void;
  /** Clears the visible transcript (screen-level concern). */
  clear?(): void;
  config?: Pick<ConfigCliHandlers, "get" | "set" | "delete">;
  models?: ModelController;
  cost?: {
    rows(): readonly UsageRecord[];
    prices: Readonly<Record<string, CostPrice>>;
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

type ChatCommand = {
  summary: string;
  /** The command starts a turn whose transcript label announces the command. */
  startsTurn?: boolean;
  run(context: ChatCommandContext, args: string): Promise<void> | void;
};

export interface ChatCommandSuggestion {
  name: string;
  summary: string;
}

const mcpActions = {
  add: "Guided setup for a new server",
  auth: "Authorize a server (OAuth browser flow, or a header)",
  reload: "Reload one or all servers",
  remove: "Remove a configured server",
  set: "Set an advanced server JSON definition",
} as const;

const modelTargets = {
  primary: "Primary agent",
  subagents: "Subagents and background jobs",
} as const;

const configActions = {
  get: "Read a global configuration value",
  set: "Set a global configuration value",
  delete: "Delete a global configuration value",
} as const;

const splitHead = (value: string): [string, string] => {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return [match?.[1] ?? "", match?.[2] ?? ""];
};

const isSensitiveConfigPath = (key: string): boolean =>
  /(?:^|\.)(?:headers|env)(?:\.|$)/u.test(key) ||
  /(?:api[_-]?key|token|secret|password)/iu.test(key);

const serverNameError = (name: string): string | null =>
  /^[A-Za-z0-9_-]+$/u.test(name) ? null : "Use letters, numbers, underscores, or hyphens.";

const successful = (result: ConfigCliResult): boolean => result.ok;

const reloadConfigPath = async (context: ChatCommandContext, key: string): Promise<void> => {
  if (!key.startsWith("mcp.")) return;
  const match = key.match(/^mcp\.servers\.([A-Za-z0-9_-]+)/u);
  await context.mcp?.reload(match?.[1]);
};

const formatMcpStatus = (status: McpRuntimeStatus): string => {
  const label = `${status.name} [${status.transport}]`;
  if (status.state === "connecting") return `${label} — connecting`;
  if (status.state === "ready") return `${label} — ${status.detail}`;
  if (status.state === "connected") return `${label} — connected`;
  return `${label} — ${status.detail}${status.usingPrevious ? " (using previous connection)" : ""}${status.resolution ? `\n  ${status.resolution}` : ""}`;
};

const requireGuidedInput = (context: ChatCommandContext): GuidedInputPort | null => {
  if (!context.guided) {
    context.emit({ type: "notice", text: "Guided input is unavailable in this session." });
    return null;
  }
  return context.guided;
};

const requireConfig = (context: ChatCommandContext): ConfigCliHandlers | null => {
  if (!context.config) {
    context.emit({ type: "notice", text: "Configuration is unavailable in this session." });
    return null;
  }
  return context.config as ConfigCliHandlers;
};

const runConfigCommand = async (context: ChatCommandContext, args: string): Promise<void> => {
  const [action, remainder] = splitHead(args);
  if (!(action in configActions)) {
    context.emit({ type: "notice", text: "Usage: /config get|set|delete <path> [JSON value]" });
    return;
  }
  const handlers = requireConfig(context);
  if (!handlers) return;
  const [key, suppliedValue] = splitHead(remainder);
  if (!key) {
    context.emit({
      type: "notice",
      text: `Usage: /config ${action} <path>${action === "set" ? " [JSON value]" : ""}`,
    });
    return;
  }
  if (action === "get") {
    if (isSensitiveConfigPath(key) || key === "mcp" || key.startsWith("mcp.servers")) {
      context.emit({ type: "notice", text: `${key} is sensitive and cannot be displayed.` });
      return;
    }
    await handlers.get({ key });
    return;
  }
  if (action === "delete") {
    const result = await handlers.delete({ key });
    if (successful(result)) await reloadConfigPath(context, key);
    return;
  }

  if (key === "providers.azure.api_key" || key === "agent.llm.providers.azure.apiKey") {
    const result = await handlers.set({ key, secret: true });
    if (successful(result)) await reloadConfigPath(context, key);
    return;
  }
  let value = suppliedValue;
  if (!value) {
    const guided = requireGuidedInput(context);
    if (!guided) return;
    const entered = await guided.askInput({
      label: `Value for ${key}`,
      masked: isSensitiveConfigPath(key),
    });
    if (entered === null) {
      context.emit({ type: "notice", text: "Configuration update cancelled." });
      return;
    }
    value = isSensitiveConfigPath(key) ? JSON.stringify(entered) : entered;
  }
  const result = await handlers.set({ key, value });
  if (successful(result)) await reloadConfigPath(context, key);
};

const setMcpServer = async (
  context: ChatCommandContext,
  name: string,
  definition: unknown,
): Promise<boolean> => {
  const parsed = mcpServerConfigSchema.safeParse(definition);
  if (!parsed.success) {
    context.emit({ type: "notice", text: `Invalid MCP server definition for ${name}.` });
    return false;
  }
  const handlers = requireConfig(context);
  if (!handlers) return false;
  const result = await handlers.set({
    key: `mcp.servers.${name}`,
    value: JSON.stringify(parsed.data),
  });
  if (!successful(result)) return false;
  await context.mcp?.reload(name);
  return true;
};

const addMcpServer = async (context: ChatCommandContext): Promise<void> => {
  const guided = requireGuidedInput(context);
  if (!guided) return;
  const name = await guided.askInput({ label: "MCP server name", validate: serverNameError });
  if (!name) return;
  const transport = await guided.askInput({
    label: "Transport",
    choices: ["http", "stdio"],
    validate: (value) => (["http", "stdio"].includes(value) ? null : "Choose http or stdio."),
  });
  if (!transport) return;
  if (transport === "http") {
    const url = await guided.askInput({
      label: "MCP URL",
      validate: (value) => {
        try {
          new URL(value);
          return null;
        } catch {
          return "Enter a valid HTTP URL.";
        }
      },
    });
    if (!url) return;
    await setMcpServer(context, name, { transport, url });
    return;
  }
  const command = await guided.askInput({
    label: "Server command",
    validate: (value) => (value.trim() ? null : "Command is required."),
  });
  if (!command) return;
  const args = await guided.askInput({
    label: "Arguments as a JSON array (Enter for none)",
    choices: ["[]"],
    validate: (value) => {
      try {
        return Array.isArray(JSON.parse(value)) ? null : "Enter a JSON array.";
      } catch {
        return "Enter a JSON array.";
      }
    },
  });
  if (args === null) return;
  await setMcpServer(context, name, { transport, command, args: JSON.parse(args) });
};

const runMcpCommand = async (context: ChatCommandContext, args: string): Promise<void> => {
  const [action, remainder] = splitHead(args);
  if (!action) {
    const statuses = context.mcp?.statuses() ?? [];
    const prompts = context.mcp?.prompts?.() ?? [];
    context.emit({
      type: "notice",
      text:
        statuses.length === 0 && prompts.length === 0
          ? "No MCP servers configured. Run /mcp add."
          : [
              ...statuses.map(formatMcpStatus),
              ...prompts.map(
                (prompt) =>
                  `/mcp:${prompt.server}:${prompt.name} — ${prompt.description ?? prompt.title ?? "MCP prompt"}`,
              ),
            ].join("\n"),
    });
    return;
  }
  if (!(action in mcpActions)) {
    context.emit({ type: "notice", text: "Usage: /mcp add|auth|reload|remove|set" });
    return;
  }
  if (action === "add") {
    await addMcpServer(context);
    return;
  }
  const [name, value] = splitHead(remainder);
  if (action === "reload") {
    await context.mcp?.reload(name || undefined);
    context.emit({
      type: "notice",
      text: `${name || "All MCP servers"} reloaded; successful changes apply on the next turn.`,
    });
    return;
  }
  if (!name || serverNameError(name)) {
    context.emit({
      type: "notice",
      text: `Usage: /mcp ${action} <server>${action === "set" ? " <JSON>" : ""}`,
    });
    return;
  }
  if (action === "remove") {
    const handlers = requireConfig(context);
    if (!handlers) return;
    const result = await handlers.delete({ key: `mcp.servers.${name}` });
    if (successful(result)) await context.mcp?.reload(name);
    return;
  }
  if (action === "auth") {
    const server = context.mcp?.statuses().find((candidate) => candidate.name === name);
    if (server && server.transport !== "http") {
      context.emit({
        type: "notice",
        text: `${name} uses stdio. Configure its env or envFrom mapping with /config set.`,
      });
      return;
    }
    // OAuth first: most hosted MCP servers (Linear, Notion, …) advertise it on
    // their 401 challenge. A failed flow falls back to a pasted header so
    // API-key-only servers still have a path.
    if (context.mcp?.authorize) {
      context.emit({
        type: "notice",
        text: `Opening your browser to authorize ${name}…`,
      });
      const flow = await context.mcp.authorize(name, {
        onAuthorizationUrl: (url) =>
          context.emit({ type: "notice", text: `Authorize ${name} at: ${url}` }),
      });
      if (flow.ok) {
        await context.mcp.reload(name);
        context.emit({ type: "notice", text: `${name} authorized; reloading.` });
        return;
      }
      context.emit({
        type: "notice",
        text: `OAuth for ${name} did not complete (${flow.reason}). Falling back to a pasted Authorization header — Esc to cancel.`,
      });
    }
    const guided = requireGuidedInput(context);
    if (!guided) return;
    const secret = await guided.askInput({
      label: `Authorization header for ${name} (e.g. "Bearer <token>")`,
      masked: true,
      validate: (entered) => (entered.length > 0 ? null : "Value is required."),
    });
    if (!secret) return;
    const handlers = requireConfig(context);
    if (!handlers) return;
    const result = await handlers.set({
      key: `mcp.servers.${name}.headers.Authorization`,
      value: JSON.stringify(secret),
    });
    if (successful(result)) await context.mcp?.reload(name);
    return;
  }
  if (!value) {
    context.emit({ type: "notice", text: "Usage: /mcp set <server> <JSON definition>" });
    return;
  }
  try {
    await setMcpServer(context, name, JSON.parse(value));
  } catch {
    context.emit({ type: "notice", text: "MCP server definition must be valid JSON." });
  }
};

const parseMcpPromptCommand = (name: string): { server: string; prompt: string } | null => {
  const match = name.match(/^mcp:([a-z0-9_-]+):([^\s:]+)$/iu);
  return match ? { server: match[1]!, prompt: match[2]! } : null;
};

const runMcpPrompt = async (
  context: ChatCommandContext,
  invocation: { server: string; prompt: string },
): Promise<void> => {
  const found = context.mcp
    ?.prompts?.()
    .find((entry) => entry.server === invocation.server && entry.name === invocation.prompt);
  if (!found || !context.mcp?.getPrompt) {
    context.emit({
      type: "notice",
      text: `Unknown MCP prompt /mcp:${invocation.server}:${invocation.prompt}.`,
    });
    return;
  }
  const guided = requireGuidedInput(context);
  if (!guided) return;
  const args: Record<string, string> = {};
  for (const argument of found.arguments ?? []) {
    const value = await guided.askInput({
      label: `MCP ${invocation.server}/${invocation.prompt}: ${argument.name}${argument.required ? " (required)" : " (optional)"}`,
      validate: (entered) =>
        argument.required && !entered.trim() ? `${argument.name} is required.` : null,
    });
    if (value === null) {
      context.emit({ type: "notice", text: "MCP prompt invocation cancelled." });
      return;
    }
    if (value || argument.required) args[argument.name] = value;
  }
  const result = await context.mcp.getPrompt(invocation.server, invocation.prompt, args);
  await context.session.send(renderMcpPrompt(invocation.server, invocation.prompt, result), {
    transcriptText: `MCP prompt: ${invocation.server}/${invocation.prompt}`,
    restoreText: `/mcp:${invocation.server}:${invocation.prompt}`,
  });
};

const runUpdateCommand = async (context: ChatCommandContext, args: string): Promise<void> => {
  const channel = args.trim() || "auto";
  if (channel !== "auto" && channel !== "next" && channel !== "latest") {
    context.emit({ type: "notice", text: "Usage: /update [next|latest]" });
    return;
  }
  if (!context.requestUpdate) {
    context.emit({ type: "notice", text: "Updates are unavailable in this session." });
    return;
  }
  await context.requestUpdate(channel as UpdateChannel);
  context.quit();
};

const runModelCommand = async (context: ChatCommandContext, args: string): Promise<void> => {
  if (!context.models) {
    context.emit({ type: "notice", text: "Model selection is unavailable in this session." });
    return;
  }
  const guided = requireGuidedInput(context);
  if (!guided) return;

  let target = args.trim();
  if (!target) {
    const selected = await guided.askInput({
      label: "Configure which agents?",
      choices: Object.keys(modelTargets),
      validate: (value) => (value in modelTargets ? null : "Choose primary or subagents."),
    });
    if (selected === null) return;
    target = selected;
  }
  if (!(target in modelTargets)) {
    context.emit({ type: "notice", text: "Usage: /model [primary|subagents]" });
    return;
  }
  const modelTarget = target as ModelTarget;
  const current = context.models.current();
  const selected = modelTarget === "primary" ? current.primary : current.subagents;
  const providerChoices = [
    ...(selected ? [selected.provider] : []),
    ...(modelTarget === "subagents" ? ["inherit"] : []),
    ...context.models.providers(),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const provider = await guided.askInput({
    label: `${modelTargets[modelTarget]} provider`,
    choices: providerChoices,
    validate: (value) =>
      providerChoices.includes(value) ? null : `Choose ${providerChoices.join(" or ")}.`,
  });
  if (provider === null) return;
  if (provider === "inherit") {
    if (await context.models.configure("subagents", null)) {
      context.emit({
        type: "notice",
        text: "Subagents now inherit the primary provider and model on new work.",
      });
    }
    return;
  }

  const modelChoices = [
    ...(selected?.provider === provider ? [selected.model] : []),
    ...context.models.modelSuggestions(provider),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  const model = await guided.askInput({
    label: `${modelTargets[modelTarget]} model ID`,
    choices: modelChoices,
    validate: (value) => (value.trim().length > 0 ? null : "Model ID is required."),
  });
  if (model === null) return;
  const selection = { provider, model: model.trim() };
  if (await context.models.configure(modelTarget, selection)) {
    context.emit({
      type: "notice",
      text: `${modelTargets[modelTarget]} will use ${selection.provider}/${selection.model} on new work.`,
    });
  }
};

/** Registry keyed by command name — same idiom as checkGraders/editModes. */
export const chatCommands: Record<string, ChatCommand> = {
  help: {
    summary: "List commands and keys",
    run(context) {
      const lines = Object.entries(chatCommands).map(
        ([name, command]) => `/${name} — ${command.summary}`,
      );
      for (const skill of context.skills ?? []) {
        if (!(skill.name in chatCommands)) lines.push(`/${skill.name} — ${skill.summary} (skill)`);
      }
      lines.push(
        "& <task> — run as a background job",
        "@path/to/file — attach file contents · Ctrl+V — paste copied files",
        "Tab/Enter — complete a shown command · Tab — toggle plan/build otherwise",
        "Esc — dismiss suggestions / dequeue waiting message / interrupt turn · Ctrl+C×2 — quit",
      );
      context.emit({ type: "notice", text: lines.join("\n") });
    },
  },
  mcp: {
    summary: "Manage and reload MCP servers",
    run: runMcpCommand,
  },
  config: {
    summary: "Read or update global configuration",
    run: runConfigCommand,
  },
  update: {
    summary: "Update agentj and exit",
    run: runUpdateCommand,
  },
  model: {
    summary: "Choose primary or subagent models",
    run: runModelCommand,
  },
  cost: {
    summary: "Show foreground token usage and estimated cost",
    run(context) {
      if (!context.cost) {
        context.emit({ type: "notice", text: "Cost reporting is unavailable in this session." });
        return;
      }
      context.emit({
        type: "notice",
        text: formatCostReport(context.cost.rows(), context.cost.prices),
      });
    },
  },
  build: {
    summary: "Switch to build mode and implement the plan",
    startsTurn: true,
    async run(context) {
      context.session.setMode("build");
      await context.session.send(
        "Implement the work agreed on in this conversation, incorporating the plan, discussion, and user feedback. Complete and validate it end to end.",
        { transcriptText: "Command: build", restoreText: "/build" },
      );
    },
  },
  jobs: {
    summary: "Inspect background jobs, or `/jobs abort <id>`",
    run(context, args) {
      const [action, remainder] = splitHead(args);
      if (action === "abort") {
        if (!remainder) {
          context.emit({ type: "notice", text: "Usage: /jobs abort <id>" });
          return;
        }
        const aborted = context.jobs.abort(remainder);
        context.emit({
          type: "notice",
          text: aborted ? `Aborting ${remainder}.` : `No running job ${remainder}.`,
        });
        return;
      }
      if (action) {
        const job = context.jobs.inspect(action);
        if (!job) {
          context.emit({ type: "notice", text: `No job ${action} in this session.` });
          return;
        }
        const elapsed = Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt);
        const minutes = Math.floor(elapsed / 60_000);
        const seconds = Math.round((elapsed % 60_000) / 1_000);
        const duration = minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
        const lines = [`[${job.id}] ${job.status} (${job.mode}) — ${duration}`, job.prompt];
        if (job.recentActivity.length > 0) {
          lines.push("recent tool calls:", ...job.recentActivity.map((entry) => `  ${entry}`));
        }
        if (job.resultText) lines.push("result:", job.resultText);
        if (job.branch) lines.push(`work preserved on ${job.branch}`);
        context.emit({ type: "notice", text: lines.join("\n") });
        return;
      }
      const jobs = context.jobs.list();
      context.emit({
        type: "notice",
        text:
          jobs.length === 0
            ? "No jobs this session."
            : jobs
                .map((job) => {
                  const elapsed = Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt);
                  const minutes = Math.floor(elapsed / 60_000);
                  const seconds = Math.round((elapsed % 60_000) / 1_000);
                  const duration = minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
                  return `${job.id} [${job.status}] (${job.mode}) ${duration} — ${job.prompt.slice(0, 60)}`;
                })
                .join("\n"),
      });
    },
  },
  undo: {
    summary: "Revert the agent's last file changes",
    async run(context) {
      const label = await context.undo?.undo();
      context.emit({
        type: "notice",
        text: label ? `Restored to: ${label}` : "Nothing to undo.",
      });
    },
  },
  redo: {
    summary: "Re-apply reverted changes",
    async run(context) {
      const label = await context.undo?.redo();
      context.emit({
        type: "notice",
        text: label ? `Re-applied: ${label}` : "Nothing to redo.",
      });
    },
  },
  clear: {
    summary: "Clear the transcript view",
    run(context) {
      context.clear?.();
    },
  },
  quit: {
    summary: "End the session",
    run(context) {
      context.quit();
    },
  },
};

interface FuzzyRank {
  kind: number;
  gaps: number;
  start: number;
}

const fuzzyRank = (name: string, query: string): FuzzyRank | null => {
  if (query.length === 0) return { kind: 0, gaps: 0, start: 0 };
  if (name === query) return { kind: 0, gaps: 0, start: 0 };
  if (name.startsWith(query)) return { kind: 1, gaps: 0, start: 0 };

  let queryIndex = 0;
  let start = -1;
  let previous = -1;
  let gaps = 0;
  for (let nameIndex = 0; nameIndex < name.length && queryIndex < query.length; nameIndex += 1) {
    if (name[nameIndex] !== query[queryIndex]) continue;
    if (start === -1) start = nameIndex;
    if (previous !== -1) gaps += nameIndex - previous - 1;
    previous = nameIndex;
    queryIndex += 1;
  }
  return queryIndex === query.length ? { kind: 2, gaps, start } : null;
};

/** Case-insensitive exact, prefix, then compact ordered-subsequence command matches. */
export function suggestChatCommands(
  query: string,
  skills: readonly Pick<SkillCommand, "name" | "summary">[] = [],
): ChatCommandSuggestion[] {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ...Object.entries(chatCommands).map(([name, command]) => [name, command.summary] as const),
    ...skills
      .filter(({ name }) => !(name in chatCommands))
      .map(({ name, summary }) => [name, `${summary} (skill)`] as const),
  ];
  const normalized = query.toLowerCase();
  if (normalized.length === 0) {
    return entries.map(([name, summary]) => ({ name, summary }));
  }
  return entries
    .map(([name, summary], index) => ({
      name,
      summary,
      index,
      rank: fuzzyRank(name.toLowerCase(), normalized),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { rank: FuzzyRank } => candidate.rank !== null,
    )
    .sort(
      (left, right) =>
        left.rank.kind - right.rank.kind ||
        left.rank.gaps - right.rank.gaps ||
        left.rank.start - right.rank.start ||
        left.name.length - right.name.length ||
        left.index - right.index,
    )
    .map(({ name, summary }) => ({ name, summary }));
}

export interface ChatInputCompletion {
  token: { start: number; end: number };
  suggestions: Array<{ value: string; label?: string; summary?: string }>;
  hint?: string;
}

const configKeySummary: Record<string, string> = {
  "agent.llm.model": "Model name",
  "agent.llm.provider": "Model provider",
  "agent.steps": "Per-turn step limit",
  "agent.tools.edit.mode": "Edit strategy",
  "agent.tools.subagents.concurrency": "Parallel subagents",
  "agent.tools.subagents.model": "Subagent model",
  "agent.tools.subagents.provider": "Subagent model provider",
  "permissions.edit": "Edit permission policy",
  "permissions.bash.default": "Default bash permission policy",
  "mcp.maxOutputChars": "Maximum MCP result size",
  "update.auto": "Automatically check for updates",
  "update.channel": "Release channel to follow",
};
const baseConfigKeys = [
  ...new Set([...listConfigPaths(), "llm.model", "providers.azure.api_key"]),
].map((key) => [key, configKeySummary[key] ?? "Configuration value"] as const);

const choiceValues: Record<string, readonly string[]> = {
  "agent.llm.provider": providerNames,
  "agent.tools.subagents.provider": providerNames,
  "agent.tools.edit.mode": ["batch", "exact", "hash"],
  "permissions.edit": ["allow", "ask", "deny"],
  "permissions.bash.default": ["allow", "ask", "deny"],
  "update.auto": ["true", "false"],
  "update.channel": ["auto", "next", "latest"],
};

const prefixedSuggestions = (
  values: ReadonlyArray<readonly [string, string]>,
  prefix: string,
  suffix = " ",
) =>
  values
    .filter(([value]) => value.toLowerCase().startsWith(prefix.toLowerCase()))
    .map(([value, summary]) => ({ value: `${value}${suffix}`, label: value, summary }));

/** Pure, synchronous command-palette completion. It reads only in-memory MCP status. */
export function completeChatInput(
  text: string,
  cursor: number,
  context?: Partial<Pick<ChatCommandContext, "mcp" | "models" | "skills" | "jobs">>,
): ChatInputCompletion | null {
  const graphemes = Array.from(text);
  const boundedCursor = Math.max(0, Math.min(cursor, graphemes.length));
  const first = graphemes.findIndex((value) => !/^\s$/u.test(value));
  if (first < 0 || graphemes[first] !== "/" || boundedCursor <= first) return null;
  let start = boundedCursor;
  while (start > first && !/^\s$/u.test(graphemes[start - 1] ?? "")) start -= 1;
  let end = boundedCursor;
  while (end < graphemes.length && !/^\s$/u.test(graphemes[end] ?? "")) end += 1;
  const prefix = graphemes.slice(start, boundedCursor).join("");
  const prior = graphemes
    .slice(first + 1, start)
    .join("")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const token = { start, end };

  if (start === first) {
    const commands = suggestChatCommands(prefix.slice(1), context?.skills).map(
      ({ name, summary }) => ({
        value: `/${name} `,
        label: `/${name}`,
        summary,
      }),
    );
    const prompts = (context?.mcp?.prompts?.() ?? [])
      .map((prompt) => ({
        name: `mcp:${prompt.server}:${prompt.name}`,
        summary: prompt.description ?? prompt.title ?? "MCP prompt",
      }))
      .filter((prompt) => prompt.name.toLowerCase().startsWith(prefix.slice(1).toLowerCase()))
      .map((prompt) => ({
        value: `/${prompt.name} `,
        label: `/${prompt.name}`,
        summary: `${prompt.summary} (MCP prompt)`,
      }));
    return { token, suggestions: [...commands, ...prompts] };
  }

  const [command, ...args] = prior;
  if (command && !(command in chatCommands)) {
    const skill = context?.skills?.find((entry) => entry.name === command);
    if (skill) {
      return {
        token,
        suggestions: [],
        hint: `Press Enter to run the ${skill.name} skill${skill.mode ? ` (${skill.mode} mode)` : ""}.`,
      };
    }
  }
  const mcpPrompt = parseMcpPromptCommand(command ?? "");
  if (mcpPrompt) {
    return {
      token,
      suggestions: [],
      hint: context?.mcp
        ?.prompts?.()
        .some((entry) => entry.server === mcpPrompt.server && entry.name === mcpPrompt.prompt)
        ? "Press Enter to provide MCP prompt arguments."
        : "Unknown MCP prompt.",
    };
  }

  if (command === "mcp") {
    if (args.length === 0) {
      return {
        token,
        suggestions: prefixedSuggestions(Object.entries(mcpActions), prefix),
        hint: "Choose an MCP action; /mcp by itself shows status.",
      };
    }
    const action = args[0];
    const servers = context?.mcp?.statuses() ?? [];
    const serverNames = servers.map(({ name }) => [name, "Configured MCP server"] as const);
    if (["auth", "reload", "remove"].includes(action ?? "") && args.length === 1) {
      const eligibleNames =
        action === "auth"
          ? servers
              .filter(({ transport }) => transport === "http")
              .map(({ name }) => [name, "HTTP MCP server"] as const)
          : serverNames;
      return {
        token,
        suggestions: prefixedSuggestions(eligibleNames, prefix),
        hint:
          action === "reload"
            ? "Leave server blank to reload all servers."
            : "Choose a configured server.",
      };
    }
    if (action === "set" && args.length === 1) {
      return {
        token,
        suggestions: prefixedSuggestions(serverNames, prefix),
        hint: "Choose an existing server or type a new server name.",
      };
    }
    return {
      token,
      suggestions: [],
      hint:
        action === "add"
          ? "Press Enter to start guided server setup."
          : action === "set"
            ? "Expected: JSON server definition."
            : action === "auth"
              ? "Press Enter for masked Authorization entry."
              : undefined,
    };
  }

  if (command === "jobs") {
    const jobIds = context?.jobs?.list().map(({ id }) => [id, "Background job"] as const) ?? [];
    if (args.length === 0) {
      return {
        token,
        suggestions: prefixedSuggestions([["abort", "Abort a running job"], ...jobIds], prefix),
        hint: "Choose a job to inspect, or choose abort.",
      };
    }
    if (args.length === 1 && args[0] === "abort") {
      return {
        token,
        suggestions: prefixedSuggestions(jobIds, prefix),
        hint: "Choose a running job to abort.",
      };
    }
    return { token, suggestions: [], hint: "Press Enter to inspect this job." };
  }

  if (command === "update") {
    return {
      token,
      suggestions: prefixedSuggestions(
        [
          ["next", "Update to the next release"],
          ["latest", "Update to the latest stable release"],
        ],
        prefix,
        "",
      ),
      hint: "Choose an update channel, or press Enter for latest.",
    };
  }

  if (command === "model") {
    if (args.length === 0) {
      return {
        token,
        suggestions: prefixedSuggestions(Object.entries(modelTargets), prefix),
        hint: "Choose what to configure, or press Enter for guided selection.",
      };
    }
    return {
      token,
      suggestions: [],
      hint: modelTargets[args[0] as ModelTarget]
        ? "Press Enter to choose a provider and model."
        : "Expected: primary or subagents.",
    };
  }

  if (command === "config") {
    if (args.length === 0) {
      return {
        token,
        suggestions: prefixedSuggestions(Object.entries(configActions), prefix),
        hint: "Choose a configuration action.",
      };
    }
    const action = args[0];
    const serverKeys = (context?.mcp?.statuses() ?? []).flatMap(({ name }) => [
      [`mcp.servers.${name}`, `${name} server definition`] as const,
      [`mcp.servers.${name}.headers.Authorization`, `${name} Authorization header`] as const,
      [`mcp.servers.${name}.url`, `${name} HTTP URL`] as const,
      [`mcp.servers.${name}.command`, `${name} stdio command`] as const,
    ]);
    const keys = [...baseConfigKeys, ...serverKeys];
    if (["get", "set", "delete"].includes(action ?? "") && args.length === 1) {
      return {
        token,
        suggestions: prefixedSuggestions(keys, prefix),
        hint: "Choose a configuration path.",
      };
    }
    if (action === "set" && args.length === 2) {
      const key = args[1] ?? "";
      const values = choiceValues[key];
      return {
        token,
        suggestions: values
          ? prefixedSuggestions(
              values.map((value) => [value, `Set ${key}`]),
              prefix,
              "",
            )
          : [],
        hint: values
          ? "Choose a value."
          : isSensitiveConfigPath(key)
            ? "Press Enter for masked entry."
            : "Expected: JSON value.",
      };
    }
  }
  return null;
}

export const shouldRememberChatInput = (text: string): boolean => {
  const parsed = parseInput(text);
  if (parsed.kind !== "command") return true;
  const [action] = splitHead(parsed.args);
  return !(
    (parsed.name === "config" && action === "set") ||
    (parsed.name === "mcp" && action === "set")
  );
};

export async function runChatCommand(
  context: ChatCommandContext,
  name: string,
  args: string,
): Promise<void> {
  const command = chatCommands[name];
  const mcpPrompt = command ? null : parseMcpPromptCommand(name);
  const skill =
    command || mcpPrompt ? undefined : context.skills?.find((entry) => entry.name === name);
  // Skill invocations start turns, so like /build they skip the command event.
  if (!command?.startsTurn && !skill && !mcpPrompt) context.emit({ type: "command", name });
  if (!command && !skill && !mcpPrompt) {
    context.emit({ type: "notice", text: `Unknown command /${name} — try /help.` });
    return;
  }
  try {
    if (command) {
      await command.run(context, args);
    } else if (mcpPrompt) {
      if (args) {
        context.emit({
          type: "notice",
          text: "MCP prompt arguments are collected interactively; do not put them in the command.",
        });
        return;
      }
      await runMcpPrompt(context, mcpPrompt);
    } else if (skill) {
      if (skill.mode) context.session.setMode(skill.mode);
      await context.session.send(skill.prompt(args), {
        transcriptText: `Command: ${name}`,
        restoreText: `/${name}${args ? ` ${args}` : ""}`,
      });
    }
  } catch {
    context.emit({
      type: "notice",
      text: `Command /${name} failed. Check the configuration and retry.`,
    });
  }
}
