import z from "zod";
import type { ToolSet } from "../llm";

/**
 * Host-first permission gating. The sandbox used to be the implicit permission
 * system; on the host, mutating tools (bash/edit/writeFile) pass through a
 * policy resolved from config, and "ask" outcomes are settled by an injected
 * gate — a plain function port the composition root wires to the TUI (or to a
 * fixed answer for non-interactive runs). Repository reads/searches are never gated; outbound web access has its own policy.
 */

export const permissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/** The `permissions.*` config section (composed into the root configSchema). */
export const permissionsConfigSchema = z.object({
  /** File edits (edit/writeFile tools) in build mode. */
  edit: permissionDecisionSchema.default("allow"),
  bash: z
    .object({
      default: permissionDecisionSchema.default("ask"),
      /** Literal command prefixes, optional trailing `*`. First match wins after deny. */
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
  mcp: z
    .object({
      default: permissionDecisionSchema.default("ask"),
      /** Canonical MCP tool names, with an optional trailing `*` wildcard. */
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Outbound web research and URL fetches. */
  web: permissionDecisionSchema.default("allow"),
});
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;

export interface PermissionRequest {
  /** The effective tool target; MCP aliases resolve to their canonical name. */
  tool: string;
  kind: "bash" | "edit" | "mcp" | "web";
  /** The command line, target path, or effective MCP tool plus its input. */
  detail: string;
  /** Who is asking when not the primary agent — e.g. "subagent t2", "job j1". */
  origin?: string;
}

export type PermissionPromptDecision = "allow" | "always" | "deny";

/** Settles "ask" outcomes. Injected; the TUI implementation prompts the user. */
export type PermissionGate = (request: PermissionRequest) => Promise<"allow" | "deny">;

/** The same gate, with every request labeled as coming from `origin` — how a
 *  child agent's asks stay attributable in a shared session gate. */
export const withRequestOrigin =
  (gate: PermissionGate, origin: string): PermissionGate =>
  (request) =>
    gate({ ...request, origin });

/**
 * Serializes interactive asks and remembers an "always" answer for this gate's
 * lifetime. Configured policy is resolved before the gate, so explicit denies
 * remain authoritative.
 */
export function createSessionPermissionGate(
  prompt: (request: PermissionRequest) => Promise<PermissionPromptDecision>,
): PermissionGate {
  let allowSession = false;
  let tail = Promise.resolve();

  return (request) => {
    const result = tail.then(async () => {
      if (allowSession) return "allow" as const;
      const decision = await prompt(request);
      if (decision === "always") allowSession = true;
      return decision === "deny" ? "deny" : "allow";
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** Literal prefix match with an optional trailing `*` wildcard. */
const matchesPattern = (pattern: string, value: string): boolean =>
  pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;

/** Pure policy resolution: deny list, then allow list, then the default. */
export function resolvePermission(
  config: PermissionsConfig,
  request: PermissionRequest,
): PermissionDecision {
  if (request.kind === "edit") return config.edit;
  if (request.kind === "web") return config.web;
  const policy = request.kind === "mcp" ? config.mcp : config.bash;
  const target = request.kind === "mcp" ? request.tool : request.detail;
  if (policy.deny.some((pattern) => matchesPattern(pattern, target))) return "deny";
  if (policy.allow.some((pattern) => matchesPattern(pattern, target))) return "allow";
  return policy.default;
}

/** Tool name → permission kind; unlisted repository read/search tools are never gated. */
const GATED_TOOLS: Record<string, PermissionRequest["kind"]> = {
  bash: "bash",
  edit: "edit",
  writeFile: "edit",
  web_search: "web",
  web_fetch: "web",
};

/** Maps an exposed tool call to its underlying authorization target. */
export type PermissionTargetResolver = (tool: string, input: unknown) => string | undefined;

const inputTool = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const tool = (input as Record<string, unknown>).tool;
  return typeof tool === "string" && tool.length > 0 ? tool : undefined;
};

const permissionKind = (tool: string): PermissionRequest["kind"] | undefined => {
  const builtIn = GATED_TOOLS[tool];
  if (builtIn) return builtIn;
  if (tool === "call_mcp_tool" || tool.startsWith("mcp_")) return "mcp";
  return undefined;
};

/** Human-readable summary of a tool input: the command, the path, a task
 *  count for fan-out or question tools, or JSON as the last resort. */
export const describeToolInput = (input: unknown): string => {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.path === "string") return record.path;
    if (typeof record.tool === "string") return record.tool;
    if (Array.isArray(record.tasks)) return `${record.tasks.length} tasks`;
    if (Array.isArray(record.questions)) return `${record.questions.length} questions`;
  }
  return JSON.stringify(input) ?? "";
};

export interface ResolvedToolTarget {
  /** Effective name used for authorization and user-visible activity. */
  tool: string;
  detail: string;
}

/** Resolve a call once so permission prompts and activity can share its identity. */
export function resolveToolTarget(
  tool: string,
  input: unknown,
  resolver?: PermissionTargetResolver,
): ResolvedToolTarget {
  const target =
    resolver?.(tool, input) ?? (tool === "call_mcp_tool" ? inputTool(input) : undefined);
  if (!target || target === tool) return { tool, detail: describeToolInput(input) };
  const inputDetail = describeToolInput(input);
  return {
    tool: target,
    detail: !inputDetail || inputDetail === target ? target : `${target}: ${inputDetail}`,
  };
}

export interface WithPermissionsOptions {
  config: PermissionsConfig;
  /** Consulted only when policy resolves to "ask". */
  gate: PermissionGate;
  /** Optional exposed-name/input → underlying target mapping (for example direct tool aliases). */
  resolveTarget?: PermissionTargetResolver;
}

/**
 * Wrap the mutating tools of a ToolSet with the permission policy. Denials
 * return an error-string tool result (never throw), so the model can adapt
 * within the same turn instead of crashing it.
 */
export function withPermissions(tools: ToolSet, options: WithPermissionsOptions): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const kind = permissionKind(name);
    if (!kind) {
      wrapped[name] = def;
      continue;
    }
    wrapped[name] = {
      ...def,
      async execute(input, executeOptions) {
        const target = resolveToolTarget(name, input, options.resolveTarget);
        const request: PermissionRequest = { ...target, kind };
        const decision = resolvePermission(options.config, request);
        const settled = decision === "ask" ? await options.gate(request) : decision;
        if (settled === "deny") {
          return `Denied by user: ${request.tool} (${request.detail}) is not permitted. Adjust your approach or ask the user to allow it.`;
        }
        return def.execute(input, executeOptions);
      },
    };
  }
  return wrapped;
}
