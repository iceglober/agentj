import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpCallToolResult,
  McpPage,
  McpReadResourceResult,
  McpRemoteResource,
  McpRemoteResourceTemplate,
  McpRemoteTool,
  McpServerClient,
  McpServerConfig,
  McpServerConnector,
} from ".";

const resolveEnvironmentValues = (
  direct: Record<string, string>,
  fromEnvironment: Record<string, string>,
  source: NodeJS.ProcessEnv,
  label: string,
): Record<string, string> => {
  const values = { ...direct };
  for (const [target, sourceName] of Object.entries(fromEnvironment)) {
    const value = source[sourceName];
    if (value === undefined) {
      throw new Error(`MCP ${label} requires environment variable ${sourceName}`);
    }
    values[target] = value;
  }
  return values;
};

/** Resolve transport credentials without exposing their values in errors or logs. */
export const resolveMcpTransportConfig = (
  config: McpServerConfig,
  source: NodeJS.ProcessEnv = process.env,
): { env?: Record<string, string>; headers?: Record<string, string> } =>
  config.transport === "stdio"
    ? {
        env: {
          ...getDefaultEnvironment(),
          ...resolveEnvironmentValues(config.env, config.envFrom, source, "stdio server"),
        },
      }
    : {
        headers: resolveEnvironmentValues(
          config.headers,
          config.headersFromEnv,
          source,
          "HTTP server",
        ),
      };

const page = <T>(items: T[], nextCursor?: string): McpPage<T> => ({
  items,
  ...(nextCursor ? { nextCursor } : {}),
});

/** Production SDK boundary for one configured MCP server. */
export const connectModelContextProtocolServer: McpServerConnector = async (
  name,
  config,
  options,
): Promise<McpServerClient> => {
  const resolved = resolveMcpTransportConfig(config);
  const transport =
    config.transport === "stdio"
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          ...(config.cwd ? { cwd: resolve(options.root, config.cwd) } : { cwd: options.root }),
          env: resolved.env,
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: resolved.headers },
        });
  const client = new Client({ name: `agentj-${name}`, version: "0.1.0" });
  let connected = false;
  try {
    await client.connect(transport);
    connected = true;
    const capabilities = client.getServerCapabilities();
    const listeners = new Set<(kind: "tools" | "resources") => void>();
    if (capabilities?.tools?.listChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        for (const listener of listeners) listener("tools");
      });
    }
    if (capabilities?.resources?.listChanged) {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        for (const listener of listeners) listener("resources");
      });
    }

    return {
      capabilities: {
        tools: capabilities?.tools !== undefined,
        resources: capabilities?.resources !== undefined,
      },
      async listTools(cursor, signal): Promise<McpPage<McpRemoteTool>> {
        const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
        return page(
          result.tools.map((tool) => ({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
          })),
          result.nextCursor,
        );
      },
      async callTool(toolName, args, signal): Promise<McpCallToolResult> {
        return (await client.callTool({ name: toolName, arguments: args }, undefined, {
          signal,
        })) as McpCallToolResult;
      },
      async listResources(cursor, signal): Promise<McpPage<McpRemoteResource>> {
        const result = await client.listResources(cursor ? { cursor } : undefined, { signal });
        return page(
          result.resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          })),
          result.nextCursor,
        );
      },
      async listResourceTemplates(cursor, signal): Promise<McpPage<McpRemoteResourceTemplate>> {
        const result = await client.listResourceTemplates(cursor ? { cursor } : undefined, {
          signal,
        });
        return page(
          result.resourceTemplates.map((resource) => ({
            uriTemplate: resource.uriTemplate,
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          })),
          result.nextCursor,
        );
      },
      async readResource(uri, signal): Promise<McpReadResourceResult> {
        return await client.readResource({ uri }, { signal });
      },
      onListChanged(listener) {
        listeners.add(listener);
      },
      async close() {
        if (!connected) return;
        connected = false;
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => transport.close().catch(() => undefined));
    throw new Error(`Unable to connect MCP server ${name}: ${String(error)}`, { cause: error });
  }
};
