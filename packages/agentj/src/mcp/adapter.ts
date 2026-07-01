// Adapt MCP tools into AI SDK tools. Each remote tool becomes a `dynamicTool` (its schema is only
// known at runtime) keyed `"<server>__<tool>"`. Every connected server's tools are merged into the
// agent's toolset alongside the built-ins.
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { McpConnection } from "./client.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The fully-qualified tool name for a server's tool, as the model sees it. */
export const mcpToolName = (server: string, tool: string): string => `${server}__${tool}`;

function renderToolResult(res: any): string {
  const blocks: unknown[] = Array.isArray(res?.content) ? res.content : [];
  const text = blocks
    .map((c: any) => (c?.type === "text" ? c.text : c?.type === "resource" ? JSON.stringify(c.resource) : `[${c?.type ?? "content"}]`))
    .join("\n");
  if (res?.isError) return `error: ${text || "tool reported an error"}`;
  if (text) return text;
  return res?.structuredContent ? JSON.stringify(res.structuredContent) : "(no output)";
}

/** Build the AI SDK ToolSet for every connected server's tools. */
export function mcpToolSet(connections: McpConnection[]): ToolSet {
  const set: ToolSet = {};
  for (const conn of connections) {
    for (const t of conn.tools) {
      set[mcpToolName(conn.server, t.name)] = dynamicTool({
        description: t.description ?? `${conn.server}: ${t.name}`,
        inputSchema: jsonSchema(t.inputSchema ?? { type: "object", properties: {} }),
        execute: async (args: unknown) => {
          try {
            const res = await conn.client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> });
            return renderToolResult(res);
          } catch (err) {
            return `error: ${msg(err)}`;
          }
        },
      });
    }
  }
  return set;
}
