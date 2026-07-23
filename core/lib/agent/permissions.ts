import z from "zod";
import type { ToolSet } from "../llm";
import { isMcpToolPattern, MCP_TOOL_PREFIX, normalizeMcpToolPattern } from "../mcp/naming";

/**
 * Host-first permission gating, as a default-deny access-control list. On the
 * host, mutating tools (bash/edit/writeFile), outbound web, and MCP tool calls
 * are gated: a request is checked against a map of tool-call patterns, and
 * anything not explicitly allowed (or asked) is denied. "ask" outcomes are
 * settled by an injected gate — a plain function port the composition root
 * wires to the TUI (or to a fixed answer for non-interactive runs). Repository
 * reads/searches are never gated. A single `uncaged` flag opens everything.
 *
 * Patterns are the idiomatic tool-call forms, no bespoke expression language:
 *   bash(pnpm *)   a bash command, prefix-matched (trailing `*`); `bash` = all
 *   edit           file edits; `edit(src/ *)` prefix-matches the path
 *   web            outbound search + fetch
 *   mcp_linear_get_issue   a canonical MCP tool id; `mcp_linear_*` = a server;
 *                          `mcp__…` (double underscore) is accepted as an alias
 */

export const permissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/** The `permissions.*` config section (composed into the root configSchema). */
export const permissionsConfigSchema = z
  .object({
    /** Open season: allow every gated tool call, bypassing the rules. */
    uncaged: z.boolean().default(false),
    /** Pattern → decision. Unmatched requests are denied (default-deny floor). */
    rules: z.record(z.string(), permissionDecisionSchema).default({}),
  })
  .prefault({});
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

export interface ParsedRule {
  kind: PermissionRequest["kind"];
  /** Inner matcher: `*` matches the whole kind; otherwise a prefix/exact pattern. */
  inner: string;
}

/**
 * Parse a rule pattern into its kind and inner matcher. Returns null for a
 * pattern that isn't a recognized tool-call form (such rules are inert).
 *   bash | bash(pnpm *) · edit | edit(src/ *) · web | web(https://x *)
 *   mcp | mcp_<server>_<tool> | mcp_<server>_* | mcp__<server>_<tool>
 */
export function parseRulePattern(raw: string): ParsedRule | null {
  const p = raw.trim();
  // MCP tools are matched by their canonical id (the `lib/mcp` naming
  // convention); `mcp` alone means the whole family, and `mcp__…` is an alias.
  if (isMcpToolPattern(p)) {
    return { kind: "mcp", inner: p === "mcp" ? "*" : normalizeMcpToolPattern(p) };
  }
  const m = p.match(/^(bash|edit|web)(?:\((.*)\))?$/);
  if (m) {
    const inner = (m[2] ?? "").trim();
    return { kind: m[1] as PermissionRequest["kind"], inner: inner === "" ? "*" : inner };
  }
  return null;
}

/** The value a rule of this kind matches against. */
const requestTarget = (request: PermissionRequest): string =>
  request.kind === "mcp" ? request.tool : request.detail;

const ruleMatches = (rule: ParsedRule, request: PermissionRequest): boolean => {
  if (rule.kind !== request.kind) return false;
  if (rule.inner === "*") return true;
  return matchesPattern(rule.inner, requestTarget(request));
};

/**
 * Default-deny resolution. `uncaged` opens everything; otherwise, of the rules
 * matching this request, a deny wins, then an allow, then an ask, and anything
 * unmatched is denied. Order-independent and idempotent.
 */
export function resolvePermission(
  config: PermissionsConfig,
  request: PermissionRequest,
): PermissionDecision {
  if (config.uncaged) return "allow";
  let matched: PermissionDecision | undefined;
  for (const [pattern, decision] of Object.entries(config.rules)) {
    const rule = parseRulePattern(pattern);
    if (!rule || !ruleMatches(rule, request)) continue;
    if (decision === "deny") return "deny";
    if (decision === "allow") matched = "allow";
    else if (matched !== "allow") matched = "ask";
  }
  return matched ?? "deny";
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
  if (tool === "call_mcp_tool" || tool.startsWith(MCP_TOOL_PREFIX)) return "mcp";
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
