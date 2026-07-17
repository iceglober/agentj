import { createHash } from "node:crypto";
import z from "zod";
import type { AgentMode, ExternalAgentTools, ExternalToolPermissionTargetResolver } from "../agent";
import { defineTool, type ToolDef, type ToolSet } from "../llm";
import { truncateWithNotice } from "../truncation";

const patternSchema = z
  .string()
  .min(1)
  .refine((value) => !value.slice(0, -1).includes("*"), "Only a trailing wildcard is supported");
const patternListSchema = z.array(patternSchema);

const toolSelectionSchema = z
  .object({
    /** Plan additionally requires the server's readOnlyHint annotation, so the
     *  wildcard default stays within plan mode's read-only contract. */
    plan: patternListSchema.default(["*"]),
    build: patternListSchema.default(["*"]),
    /** Eligible tools matching these patterns are exposed with their native schema. */
    direct: patternListSchema.default([]),
  })
  .prefault({});

const resourceSelectionSchema = z
  .object({
    /** Resources are reads; plan gets them by default. */
    plan: patternListSchema.default(["*"]),
    build: patternListSchema.default(["*"]),
  })
  .prefault({});

const serverFields = {
  tools: toolSelectionSchema,
  resources: resourceSelectionSchema,
};

export const mcpStdioServerConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Child environment name → source process environment name. */
  envFrom: z.record(z.string(), z.string().min(1)).default({}),
  ...serverFields,
});

export const mcpHttpServerConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  /** HTTP header name → source process environment name. */
  headersFromEnv: z.record(z.string(), z.string().min(1)).default({}),
  ...serverFields,
});

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  mcpStdioServerConfigSchema,
  mcpHttpServerConfigSchema,
]);

export const mcpConfigSchema = z
  .object({
    servers: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, underscores, or hyphens"),
        mcpServerConfigSchema,
      )
      .default({}),
    maxOutputChars: z.number().int().min(1_000).max(1_000_000).default(30_000),
  })
  .prefault({});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export interface McpPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface McpRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** The server's readOnlyHint annotation — an untrusted hint, absent = false. */
  readOnly?: boolean;
}

export interface McpRemoteResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpRemoteResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpCallToolResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  toolResult?: unknown;
}

export interface McpReadResourceResult {
  contents: unknown[];
}

export interface McpServerClient {
  capabilities: { tools: boolean; resources: boolean };
  listTools(cursor?: string, signal?: AbortSignal): Promise<McpPage<McpRemoteTool>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult>;
  listResources(cursor?: string, signal?: AbortSignal): Promise<McpPage<McpRemoteResource>>;
  listResourceTemplates(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<McpPage<McpRemoteResourceTemplate>>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult>;
  onListChanged?(listener: (kind: "tools" | "resources") => void): void;
  close(): Promise<void>;
}

export interface McpServerConnectorOptions {
  root: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** OAuth credential storage; HTTP connects attach saved tokens and refresh. */
  oauth?: import("./oauth").McpOAuthStorage;
}

export type McpServerConnector = (
  name: string,
  config: McpServerConfig,
  options: McpServerConnectorOptions,
) => Promise<McpServerClient>;

export interface McpServerConnection {
  name: string;
  config: McpServerConfig;
  client: McpServerClient;
  tools: McpRemoteTool[];
  resources: McpRemoteResource[];
  templates: McpRemoteResourceTemplate[];
  toolsStale: boolean;
  resourcesStale: boolean;
}

export interface McpConnection {
  externalTools: Record<AgentMode, ExternalAgentTools>;
  close(): Promise<void>;
}

const matchesPattern = (pattern: string, value: string): boolean =>
  pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;

const matchesAny = (patterns: readonly string[], ...values: string[]): boolean =>
  patterns.some((pattern) => values.some((value) => matchesPattern(pattern, value)));

const canonicalSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed";

export const canonicalMcpToolName = (server: string, tool: string): string => {
  const full = `mcp_${canonicalSegment(server)}_${canonicalSegment(tool)}`;
  if (full.length <= 64) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 55)}_${suffix}`;
};

const requestSignal = (options: unknown): AbortSignal | undefined => {
  if (typeof options !== "object" || options === null) return undefined;
  const signal = (options as { abortSignal?: unknown }).abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
};

async function allPages<T>(load: (cursor?: string) => Promise<McpPage<T>>): Promise<T[]> {
  const output: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    output.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error(`MCP pagination repeated cursor: ${cursor}`);
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return output;
}

const comparableText = (...values: Array<string | undefined>): string =>
  values
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

const searchScore = (query: string, name: string, text: string): number => {
  const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 1;
  const lowerName = name.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!text.includes(term)) return -1;
    score +=
      lowerName === term
        ? 100
        : lowerName.startsWith(term)
          ? 20
          : lowerName.includes(term)
            ? 10
            : 1;
  }
  return score;
};

const boundedJson = (value: unknown, maxChars: number): string =>
  truncateWithNotice(JSON.stringify(value, null, 2) ?? "null", maxChars);

const summarizeContent = (content: unknown): unknown => {
  if (typeof content !== "object" || content === null) return content;
  const record = content as Record<string, unknown>;
  if (typeof record.blob === "string") {
    return { ...record, blob: undefined, omittedBytes: record.blob.length };
  }
  if ((record.type === "image" || record.type === "audio") && typeof record.data === "string") {
    return { type: record.type, mimeType: record.mimeType, omittedBytes: record.data.length };
  }
  if (
    record.type === "resource" &&
    typeof record.resource === "object" &&
    record.resource !== null
  ) {
    const resource = record.resource as Record<string, unknown>;
    if (typeof resource.blob === "string") {
      return {
        ...record,
        resource: { ...resource, blob: undefined, omittedBytes: resource.blob.length },
      };
    }
  }
  return content;
};

export const normalizeMcpToolResult = (
  result: McpCallToolResult,
  maxChars = 30_000,
): string | { error: string } => {
  const value = {
    ...(result.content ? { content: result.content.map(summarizeContent) } : {}),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.toolResult !== undefined ? { toolResult: result.toolResult } : {}),
  };
  const output = boundedJson(value, maxChars);
  return result.isError ? { error: output } : output;
};

export const normalizeMcpResourceResult = (
  result: McpReadResourceResult,
  maxChars = 30_000,
): string => boundedJson({ contents: result.contents.map(summarizeContent) }, maxChars);

const uriTemplateMatches = (template: string, uri: string): boolean => {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/gu, ".+")}$`, "u").test(uri);
};

const zodObjectInput = z.record(z.string(), z.unknown());
const findToolsInput = z.object({
  query: z.string().default(""),
  server: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
const callToolInput = z.object({ tool: z.string().min(1), arguments: zodObjectInput.default({}) });
const findResourcesInput = findToolsInput;
const readResourceInput = z.object({ server: z.string().min(1), uri: z.string().min(1) });

function directTool(
  state: McpServerConnection,
  remote: McpRemoteTool,
  maxOutputChars: number,
): ToolDef {
  return {
    description:
      remote.description ?? remote.title ?? `Call ${remote.name} on MCP server ${state.name}.`,
    inputSchema: zodObjectInput,
    jsonSchema: remote.inputSchema,
    execute: async (input, options) =>
      normalizeMcpToolResult(
        await state.client.callTool(
          remote.name,
          input as Record<string, unknown>,
          requestSignal(options),
        ),
        maxOutputChars,
      ),
  };
}

export class McpToolCollisionError extends Error {
  readonly serverNames: readonly string[];

  constructor(first: string, second: string, canonical: string) {
    super(`MCP tool name collision: ${first} and ${second} both map to ${canonical}`);
    this.name = "McpToolCollisionError";
    this.serverNames = Object.freeze([
      first.split("/", 1)[0] ?? first,
      second.split("/", 1)[0] ?? second,
    ]);
  }
}

export const validateMcpToolNames = (states: readonly McpServerConnection[]): void => {
  const names = new Map<string, string>();
  for (const state of states) {
    for (const tool of state.tools) {
      const canonical = canonicalMcpToolName(state.name, tool.name);
      const source = `${state.name}/${tool.name}`;
      const existing = names.get(canonical);
      if (existing && existing !== source) {
        throw new McpToolCollisionError(existing, source, canonical);
      }
      names.set(canonical, source);
    }
  }
};

export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
  options: McpServerConnectorOptions & { connectServer: McpServerConnector },
): Promise<McpServerConnection> {
  const client = await options.connectServer(name, config, {
    root: options.root,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.oauth ? { oauth: options.oauth } : {}),
  });
  const state: McpServerConnection = {
    name,
    config,
    client,
    tools: [],
    resources: [],
    templates: [],
    toolsStale: false,
    resourcesStale: false,
  };
  try {
    state.tools = client.capabilities.tools
      ? await allPages((cursor) => client.listTools(cursor, options.signal))
      : [];
    if (client.capabilities.resources) {
      [state.resources, state.templates] = await Promise.all([
        allPages((cursor) => client.listResources(cursor, options.signal)),
        allPages((cursor) => client.listResourceTemplates(cursor, options.signal)),
      ]);
    }
    client.onListChanged?.((kind) => {
      if (kind === "tools") state.toolsStale = true;
      else state.resourcesStale = true;
    });
    validateMcpToolNames([state]);
    return state;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export function createMcpExternalTools(
  states: readonly McpServerConnection[],
  maxOutputChars: number,
): Record<AgentMode, ExternalAgentTools> {
  validateMcpToolNames(states);
  const refreshTools = async (state: McpServerConnection): Promise<void> => {
    if (!state.toolsStale) return;
    state.tools = await allPages((cursor) => state.client.listTools(cursor));
    state.toolsStale = false;
    validateMcpToolNames(states);
  };
  const refreshResources = async (state: McpServerConnection): Promise<void> => {
    if (!state.resourcesStale) return;
    [state.resources, state.templates] = await Promise.all([
      allPages((cursor) => state.client.listResources(cursor)),
      allPages((cursor) => state.client.listResourceTemplates(cursor)),
    ]);
    state.resourcesStale = false;
  };

  const externalTools = Object.fromEntries(
    (["plan", "build"] as const).map((mode) => {
      const tools: ToolSet = {};
      const permissionTargets: Record<string, ExternalToolPermissionTargetResolver> = {};
      const eligibleTools = (): Array<{
        state: McpServerConnection;
        remote: McpRemoteTool;
        canonical: string;
      }> =>
        states.flatMap((state) =>
          state.tools
            // Plan mode is read-only: beyond the configured pattern, a tool
            // must carry the server's readOnlyHint annotation to be exposed.
            .filter(
              (remote) =>
                matchesAny(state.config.tools[mode], remote.name) &&
                (mode !== "plan" || remote.readOnly === true),
            )
            .map((remote) => ({
              state,
              remote,
              canonical: canonicalMcpToolName(state.name, remote.name),
            })),
        );

      for (const entry of eligibleTools()) {
        if (!matchesAny(entry.state.config.tools.direct, entry.remote.name)) continue;
        tools[entry.canonical] = directTool(entry.state, entry.remote, maxOutputChars);
        permissionTargets[entry.canonical] = () => entry.canonical;
      }

      if (states.some((state) => state.config.tools[mode].length > 0)) {
        tools.find_mcp_tools = defineTool({
          description:
            "Search configured MCP tools. Returns canonical tool names and JSON input schemas for call_mcp_tool.",
          inputSchema: findToolsInput,
          execute: async ({ query, server, limit }) => {
            await Promise.all(states.map(refreshTools));
            return boundedJson(
              eligibleTools()
                .filter((entry) => !server || entry.state.name === server)
                .map((entry) => ({
                  ...entry,
                  score: searchScore(
                    query,
                    entry.remote.name,
                    comparableText(
                      entry.state.name,
                      entry.remote.name,
                      entry.remote.title,
                      entry.remote.description,
                    ),
                  ),
                }))
                .filter((entry) => entry.score >= 0)
                .sort((a, b) => b.score - a.score || a.canonical.localeCompare(b.canonical))
                .slice(0, limit)
                .map(({ state, remote, canonical }) => ({
                  tool: canonical,
                  server: state.name,
                  name: remote.name,
                  description: remote.description ?? remote.title,
                  inputSchema: remote.inputSchema,
                })),
              maxOutputChars,
            );
          },
        });
        tools.call_mcp_tool = defineTool({
          description:
            "Call an MCP tool found with find_mcp_tools using its canonical name and schema-compliant arguments.",
          inputSchema: callToolInput,
          execute: async ({ tool, arguments: args }, executeOptions) => {
            await Promise.all(states.map(refreshTools));
            const entry = eligibleTools().find((candidate) => candidate.canonical === tool);
            if (!entry)
              return { error: `Unknown or unavailable MCP tool for ${mode} mode: ${tool}` };
            return normalizeMcpToolResult(
              await entry.state.client.callTool(
                entry.remote.name,
                args,
                requestSignal(executeOptions),
              ),
              maxOutputChars,
            );
          },
        });
        permissionTargets.call_mcp_tool = (input) =>
          callToolInput.safeParse(input).success ? (input as { tool: string }).tool : undefined;
      }

      const eligibleResources = () =>
        states.flatMap((state) => {
          const patterns = state.config.resources[mode];
          return [
            ...state.resources
              .filter((resource) => matchesAny(patterns, resource.name, resource.uri))
              .map((resource) => ({ state, kind: "resource" as const, resource })),
            ...state.templates
              .filter((template) => matchesAny(patterns, template.name, template.uriTemplate))
              .map((resource) => ({ state, kind: "template" as const, resource })),
          ];
        });

      if (states.some((state) => state.config.resources[mode].length > 0)) {
        tools.find_mcp_resources = defineTool({
          description: "Search configured MCP resources and URI templates available in this mode.",
          inputSchema: findResourcesInput,
          execute: async ({ query, server, limit }) => {
            await Promise.all(states.map(refreshResources));
            return boundedJson(
              eligibleResources()
                .filter((entry) => !server || entry.state.name === server)
                .map((entry) => {
                  const uri =
                    entry.kind === "resource" ? entry.resource.uri : entry.resource.uriTemplate;
                  return {
                    entry,
                    uri,
                    score: searchScore(
                      query,
                      entry.resource.name,
                      comparableText(
                        entry.state.name,
                        entry.resource.name,
                        entry.resource.title,
                        entry.resource.description,
                        uri,
                      ),
                    ),
                  };
                })
                .filter(({ score }) => score >= 0)
                .sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri))
                .slice(0, limit)
                .map(({ entry, uri }) => ({
                  server: entry.state.name,
                  kind: entry.kind,
                  name: entry.resource.name,
                  uri,
                  description: entry.resource.description ?? entry.resource.title,
                  mimeType: entry.resource.mimeType,
                })),
              maxOutputChars,
            );
          },
        });
        tools.read_mcp_resource = defineTool({
          description:
            "Read an MCP resource returned by find_mcp_resources. Expand URI template variables before calling.",
          inputSchema: readResourceInput,
          execute: async ({ server, uri }, executeOptions) => {
            await Promise.all(states.map(refreshResources));
            const state = states.find((candidate) => candidate.name === server);
            const eligible = eligibleResources().some(
              (entry) =>
                entry.state === state &&
                (entry.kind === "resource"
                  ? entry.resource.uri === uri
                  : uriTemplateMatches(entry.resource.uriTemplate, uri)),
            );
            if (!state || !eligible) {
              return {
                error: `Unknown or unavailable MCP resource for ${mode} mode: ${server}/${uri}`,
              };
            }
            return normalizeMcpResourceResult(
              await state.client.readResource(uri, requestSignal(executeOptions)),
              maxOutputChars,
            );
          },
        });
      }

      return [mode, { tools, permissionTargets }];
    }),
  ) as Record<AgentMode, ExternalAgentTools>;

  return externalTools;
}

export interface McpSnapshot {
  readonly version: number;
  readonly externalTools: Readonly<Record<AgentMode, ExternalAgentTools>>;
}

export const createMcpSnapshot = (
  states: readonly McpServerConnection[],
  maxOutputChars: number,
  version: number,
): McpSnapshot => {
  const externalTools = createMcpExternalTools(
    [...states].sort((left, right) => left.name.localeCompare(right.name)),
    maxOutputChars,
  );
  for (const mode of ["plan", "build"] as const) {
    Object.freeze(externalTools[mode].tools);
    if (externalTools[mode].permissionTargets) {
      Object.freeze(externalTools[mode].permissionTargets);
    }
    Object.freeze(externalTools[mode]);
  }
  return Object.freeze({ version, externalTools: Object.freeze(externalTools) });
};

export async function connectMcp(
  config: McpConfig,
  options: { root: string; connectServer: McpServerConnector },
): Promise<McpConnection> {
  const states: McpServerConnection[] = [];
  try {
    for (const name of Object.keys(config.servers).sort()) {
      const serverConfig = config.servers[name];
      if (!serverConfig) continue;
      states.push(
        await connectMcpServer(name, serverConfig, {
          root: options.root,
          connectServer: options.connectServer,
        }),
      );
    }
    const externalTools = createMcpSnapshot(states, config.maxOutputChars, 0).externalTools;
    return {
      externalTools: externalTools as Record<AgentMode, ExternalAgentTools>,
      async close() {
        const outcomes = await Promise.allSettled(states.map((state) => state.client.close()));
        const failed = outcomes.find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
        );
        if (failed) throw failed.reason;
      },
    };
  } catch (error) {
    await Promise.allSettled(states.map((state) => state.client.close()));
    throw error;
  }
}
