import { describe, expect, test } from "bun:test";
import type { ToolDef } from "../llm";
import {
  canonicalMcpToolName,
  connectMcp,
  type McpPage,
  type McpRemoteResource,
  type McpRemoteResourceTemplate,
  type McpRemoteTool,
  type McpServerClient,
  mcpConfigSchema,
  normalizeMcpToolResult,
} from ".";

const execute = (tool: ToolDef | undefined, input: unknown, options?: unknown) => {
  if (!tool) throw new Error("missing test tool");
  return tool.execute(input, options);
};

class FakeClient implements McpServerClient {
  capabilities = { tools: true, resources: true };
  tools: McpRemoteTool[] = [];
  resources: McpRemoteResource[] = [];
  templates: McpRemoteResourceTemplate[] = [];
  calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
  reads: Array<{ uri: string; signal?: AbortSignal }> = [];
  closes = 0;
  toolLists = 0;
  resourceLists = 0;
  listener?: (kind: "tools" | "resources") => void;

  async listTools(cursor?: string): Promise<McpPage<McpRemoteTool>> {
    this.toolLists += 1;
    if (!cursor && this.tools.length > 1) return { items: this.tools.slice(0, 1), nextCursor: "2" };
    return { items: cursor ? this.tools.slice(1) : this.tools };
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    this.calls.push({ name, args, ...(signal ? { signal } : {}) });
    return { content: [{ type: "text", text: `${name}:${String(args.query ?? "")}` }] };
  }

  async listResources(): Promise<McpPage<McpRemoteResource>> {
    this.resourceLists += 1;
    return { items: this.resources };
  }

  async listResourceTemplates(): Promise<McpPage<McpRemoteResourceTemplate>> {
    return { items: this.templates };
  }

  async readResource(uri: string, signal?: AbortSignal) {
    this.reads.push({ uri, ...(signal ? { signal } : {}) });
    return { contents: [{ uri, text: "resource body" }] };
  }

  onListChanged(listener: (kind: "tools" | "resources") => void): void {
    this.listener = listener;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

const tool = (name: string, description = name, readOnly?: boolean): McpRemoteTool => ({
  name,
  description,
  ...(readOnly ? { readOnly } : {}),
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
});

describe("mcpConfigSchema", () => {
  test("defaults to no servers and applies safe mode exposure defaults", () => {
    expect(mcpConfigSchema.parse({})).toEqual({ servers: {}, maxOutputChars: 30_000 });
    const parsed = mcpConfigSchema.parse({
      servers: { local: { transport: "stdio", command: "server" } },
    });
    expect(parsed.servers.local?.tools).toEqual({ plan: ["*"], build: ["*"], direct: [] });
    expect(parsed.servers.local?.resources).toEqual({ plan: ["*"], build: ["*"] });
  });

  test("rejects ambiguous wildcards and unsafe server identifiers", () => {
    expect(() =>
      mcpConfigSchema.parse({
        servers: { "bad.name": { transport: "stdio", command: "server" } },
      }),
    ).toThrow();
    expect(() =>
      mcpConfigSchema.parse({
        servers: {
          local: { transport: "stdio", command: "server", tools: { build: ["foo*bar"] } },
        },
      }),
    ).toThrow();
  });
});

describe("connectMcp", () => {
  test("paginates discovery and exposes mode-filtered direct and catalog tools", async () => {
    const client = new FakeClient();
    client.tools = [
      tool("search-code", "Search source code", true),
      tool("delete_issue", "Delete issue"),
    ];
    const config = mcpConfigSchema.parse({
      servers: {
        github: {
          transport: "stdio",
          command: "server",
          tools: { plan: ["search*"], build: ["*"], direct: ["search*"] },
          resources: { plan: [], build: [] },
        },
      },
    });
    const connection = await connectMcp(config, {
      root: "/repo",
      connectServer: async () => client,
    });

    expect(client.toolLists).toBe(2);
    expect(Object.keys(connection.externalTools.plan.tools).sort()).toEqual([
      "call_mcp_tool",
      "find_mcp_tools",
      "mcp_github_search_code",
    ]);
    expect(connection.externalTools.build.tools).toHaveProperty("mcp_github_search_code");
    expect(connection.externalTools.build.tools).not.toHaveProperty("mcp_github_delete_issue");

    const found = String(
      await execute(connection.externalTools.build.tools.find_mcp_tools, {
        query: "delete issue",
        limit: 8,
      }),
    );
    expect(found).toContain("mcp_github_delete_issue");
    expect(found).toContain('"inputSchema"');

    const controller = new AbortController();
    const output = await execute(
      connection.externalTools.build.tools.call_mcp_tool,
      { tool: "mcp_github_delete_issue", arguments: { query: "42" } },
      { abortSignal: controller.signal },
    );
    expect(String(output)).toContain("delete_issue:42");
    expect(client.calls).toEqual([
      { name: "delete_issue", args: { query: "42" }, signal: controller.signal },
    ]);
    expect(
      connection.externalTools.build.permissionTargets?.call_mcp_tool?.({
        tool: "mcp_github_delete_issue",
      }),
    ).toBe("mcp_github_delete_issue");
    await connection.close();
    expect(client.closes).toBe(1);
  });

  test("plan mode exposes only tools the server annotates read-only", async () => {
    const client = new FakeClient();
    client.tools = [
      tool("list_issues", "List issues", true),
      tool("save_issue", "Create or update an issue"),
    ];
    const connection = await connectMcp(
      mcpConfigSchema.parse({
        servers: {
          linear: { transport: "stdio", command: "server", tools: { direct: ["*"] } },
        },
      }),
      { root: "/repo", connectServer: async () => client },
    );

    // Defaults are wildcard for both modes; the annotation is the plan gate.
    expect(connection.externalTools.plan.tools).toHaveProperty("mcp_linear_list_issues");
    expect(connection.externalTools.plan.tools).not.toHaveProperty("mcp_linear_save_issue");
    expect(connection.externalTools.build.tools).toHaveProperty("mcp_linear_list_issues");
    expect(connection.externalTools.build.tools).toHaveProperty("mcp_linear_save_issue");
    await connection.close();
  });

  test("finds and reads eligible resources and expanded templates", async () => {
    const client = new FakeClient();
    client.resources = [{ name: "guide", uri: "docs://guide", description: "Project guide" }];
    client.templates = [
      { name: "issue", uriTemplate: "github://issues/{number}", description: "GitHub issue" },
    ];
    const connection = await connectMcp(
      mcpConfigSchema.parse({
        servers: {
          docs: {
            transport: "http",
            url: "https://example.com/mcp",
            tools: { build: [] },
            resources: { plan: ["guide", "issue"], build: ["*"] },
          },
        },
      }),
      { root: "/repo", connectServer: async () => client },
    );

    const found = String(
      await execute(connection.externalTools.plan.tools.find_mcp_resources, {
        query: "issue",
        limit: 5,
      }),
    );
    expect(found).toContain("github://issues/{number}");
    const read = await execute(
      connection.externalTools.plan.tools.read_mcp_resource,
      { server: "docs", uri: "github://issues/42" },
      { abortSignal: new AbortController().signal },
    );
    expect(String(read)).toContain("resource body");
    expect(client.reads[0]?.uri).toBe("github://issues/42");

    const denied = await execute(connection.externalTools.plan.tools.read_mcp_resource, {
      server: "docs",
      uri: "secrets://not-listed",
    });
    expect(denied).toEqual({
      error: "Unknown or unavailable MCP resource for plan mode: docs/secrets://not-listed",
    });
    await connection.close();
  });

  test("invalidates catalogs lazily and cleans up partial startup", async () => {
    const client = new FakeClient();
    client.tools = [tool("before")];
    const config = mcpConfigSchema.parse({
      servers: {
        first: { transport: "stdio", command: "one", resources: { build: [] } },
      },
    });
    const connection = await connectMcp(config, {
      root: "/repo",
      connectServer: async () => client,
    });
    expect(client.toolLists).toBe(1);
    client.tools = [tool("after")];
    client.listener?.("tools");
    const found = await execute(connection.externalTools.build.tools.find_mcp_tools, {
      query: "after",
      limit: 8,
    });
    expect(String(found)).toContain("mcp_first_after");
    expect(client.toolLists).toBe(2);
    await connection.close();

    const opened = new FakeClient();
    await expect(
      connectMcp(
        mcpConfigSchema.parse({
          servers: {
            first: { transport: "stdio", command: "one" },
            second: { transport: "stdio", command: "two" },
          },
        }),
        {
          root: "/repo",
          connectServer: async (name) => {
            if (name === "second") throw new Error("boom");
            return opened;
          },
        },
      ),
    ).rejects.toThrow("boom");
    expect(opened.closes).toBe(1);
  });

  test("rejects canonical collisions instead of overriding tools", async () => {
    const client = new FakeClient();
    client.tools = [tool("foo-bar"), tool("foo_bar")];
    await expect(
      connectMcp(
        mcpConfigSchema.parse({
          servers: { local: { transport: "stdio", command: "server" } },
        }),
        { root: "/repo", connectServer: async () => client },
      ),
    ).rejects.toThrow(/MCP tool name collision/);
    expect(client.closes).toBe(1);
    expect(canonicalMcpToolName("Local-Server", "Foo Bar")).toBe("mcp_local_server_foo_bar");
    const longName = canonicalMcpToolName("server", "x".repeat(100));
    expect(longName).toHaveLength(64);
    expect(longName).not.toBe(canonicalMcpToolName("server", `${"x".repeat(99)}y`));
  });
});

describe("MCP result normalization", () => {
  test("marks MCP errors, truncates output, and removes encoded binary bodies", () => {
    const result = normalizeMcpToolResult(
      {
        isError: true,
        content: [
          { type: "image", mimeType: "image/png", data: "a".repeat(2_000) },
          { type: "text", text: "x".repeat(2_000) },
        ],
      },
      1_000,
    );
    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain("a".repeat(100));
    expect(JSON.stringify(result)).toContain("omittedBytes");
    expect(Array.from((result as { error: string }).error).length).toBe(1_000);
  });
});
