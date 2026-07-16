import z from "zod";
import type { ToolSet } from "../llm";

/**
 * Host-first permission gating. The sandbox used to be the implicit permission
 * system; on the host, mutating tools (bash/edit/writeFile) pass through a
 * policy resolved from config, and "ask" outcomes are settled by an injected
 * gate — a plain function port the composition root wires to the TUI (or to a
 * fixed answer for non-interactive runs). Read/search tools are never gated.
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
});
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;

export interface PermissionRequest {
  tool: string;
  kind: "bash" | "edit";
  /** The command line for bash; the target path for edits. */
  detail: string;
}

export type PermissionPromptDecision = "allow" | "always" | "deny";

/** Settles "ask" outcomes. Injected; the TUI implementation prompts the user. */
export type PermissionGate = (request: PermissionRequest) => Promise<"allow" | "deny">;

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
  if (config.bash.deny.some((pattern) => matchesPattern(pattern, request.detail))) return "deny";
  if (config.bash.allow.some((pattern) => matchesPattern(pattern, request.detail))) return "allow";
  return config.bash.default;
}

/** Tool name → permission kind; unlisted tools (read/search) are never gated. */
const GATED_TOOLS: Record<string, PermissionRequest["kind"]> = {
  bash: "bash",
  edit: "edit",
  writeFile: "edit",
};

/** Human-readable summary of a tool input: the command, the path, a task
 *  count for fan-out tools, or JSON as the last resort. */
export const describeToolInput = (input: unknown): string => {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.path === "string") return record.path;
    if (Array.isArray(record.tasks)) return `${record.tasks.length} tasks`;
  }
  return JSON.stringify(input) ?? "";
};

export interface WithPermissionsOptions {
  config: PermissionsConfig;
  /** Consulted only when policy resolves to "ask". */
  gate: PermissionGate;
}

/**
 * Wrap the mutating tools of a ToolSet with the permission policy. Denials
 * return an error-string tool result (never throw), so the model can adapt
 * within the same turn instead of crashing it.
 */
export function withPermissions(tools: ToolSet, options: WithPermissionsOptions): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const kind = GATED_TOOLS[name];
    if (!kind) {
      wrapped[name] = def;
      continue;
    }
    wrapped[name] = {
      ...def,
      async execute(input, executeOptions) {
        const request: PermissionRequest = { tool: name, kind, detail: describeToolInput(input) };
        const decision = resolvePermission(options.config, request);
        const settled = decision === "ask" ? await options.gate(request) : decision;
        if (settled === "deny") {
          return `Denied by user: ${name} (${request.detail}) is not permitted. Adjust your approach or ask the user to allow it.`;
        }
        return def.execute(input, executeOptions);
      },
    };
  }
  return wrapped;
}
