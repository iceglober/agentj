import { describe, expect, test } from "bun:test";
import { type McpServerClient, type McpServerConfig, mcpConfigSchema } from ".";
import { createMcpRuntime } from "./runtime";

const client = (toolName: string, closed: string[], name: string): McpServerClient => ({
  capabilities: { tools: true, resources: false, prompts: false },
  async listPrompts() {
    return { items: [] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async listTools() {
    return {
      items: [
        {
          name: toolName,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool() {
    return { content: [] };
  },
  async listResources() {
    return { items: [] };
  },
  async listResourceTemplates() {
    return { items: [] };
  },
  async readResource() {
    return { contents: [] };
  },
  async close() {
    closed.push(name);
  },
});

const config = (servers: Record<string, McpServerConfig>) => mcpConfigSchema.parse({ servers });
const stdio = (command: string) =>
  mcpConfigSchema.parse({ servers: { value: { transport: "stdio", command } } }).servers.value!;

describe("createMcpRuntime", () => {
  test("isolates failures, stages successful servers, and activates a versioned snapshot", async () => {
    const closed: string[] = [];
    const statuses: string[] = [];
    const runtime = createMcpRuntime(config({ good: stdio("good"), bad: stdio("bad") }), {
      root: "/repo",
      connectServer: async (name) => {
        if (name === "bad") throw new Error("HTTP 401 with secret response body");
        return client("search", closed, name);
      },
      onStatus: (status) => statuses.push(`${status.name}:${status.state}`),
    });

    await expect(
      runtime.reload(config({ good: stdio("good"), bad: stdio("bad") })),
    ).resolves.toBeUndefined();
    expect(runtime.snapshot().version).toBe(0);
    expect(runtime.statuses()).toContainEqual({
      name: "bad",
      transport: "stdio",
      state: "failed",
      code: "authentication_failed",
      detail: "authentication was rejected",
      resolution: "Run /mcp auth bad; reload is automatic.",
      usingPrevious: false,
    });
    expect(await runtime.activatePending()).toBe(true);
    expect(runtime.snapshot().version).toBe(1);
    expect(runtime.snapshot().externalTools.build.tools).toHaveProperty("find_mcp_tools");
    expect(runtime.statuses()).toContainEqual({
      name: "good",
      transport: "stdio",
      state: "connected",
    });
    expect(statuses).toContain("bad:failed");
    await runtime.close();
    expect(closed).toContain("good");
  });

  test("classifies the SDK's numeric 401 code, whose message never says 401", async () => {
    const sdkError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'),
      { code: 401 },
    );
    const runtime = createMcpRuntime(config({ hosted: stdio("hosted") }), {
      root: "/repo",
      connectServer: async (name) => {
        throw new Error(`Unable to connect MCP server ${name}`, { cause: sdkError });
      },
      onStatus: () => undefined,
    });
    await runtime.reload(config({ hosted: stdio("hosted") }));
    expect(runtime.statuses()).toContainEqual({
      name: "hosted",
      transport: "stdio",
      state: "failed",
      code: "authentication_failed",
      detail: "authentication was rejected",
      resolution: "Run /mcp auth hosted; reload is automatic.",
      usingPrevious: false,
    });
    await runtime.close();
  });

  test("keeps a working server when reload fails and removes it only after activation", async () => {
    const closed: string[] = [];
    let fail = false;
    const initial = config({ docs: stdio("docs") });
    const runtime = createMcpRuntime(initial, {
      root: "/repo",
      connectServer: async (name) => {
        if (fail) throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
        return client("lookup", closed, name);
      },
    });

    await runtime.reload(initial);
    await runtime.activatePending();
    fail = true;
    await runtime.reload(initial, "docs");
    expect(runtime.statuses()[0]).toMatchObject({
      name: "docs",
      transport: "stdio",
      state: "failed",
      code: "command_not_found",
      usingPrevious: true,
    });
    expect(runtime.snapshot().externalTools.build.tools).toHaveProperty("find_mcp_tools");

    await runtime.reload(config({}), "docs", { skip: ["docs"] });
    await runtime.activatePending();
    expect(runtime.snapshot().externalTools.build.tools).toHaveProperty("find_mcp_tools");

    await runtime.reload(config({}), "docs");
    expect(runtime.snapshot().externalTools.build.tools).toHaveProperty("find_mcp_tools");
    await runtime.activatePending();
    expect(runtime.snapshot().externalTools.build.tools).not.toHaveProperty("find_mcp_tools");
    expect(closed).toContain("docs");
    await runtime.close();
  });

  test("bounds connection attempts and reports a safe timeout resolution", async () => {
    const next = config({ slow: stdio("slow") });
    const runtime = createMcpRuntime(next, {
      root: "/repo",
      timeoutMs: 5,
      connectServer: async (_name, _config, options) =>
        await new Promise<McpServerClient>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new Error("secret backend detail")),
          );
        }),
    });
    await runtime.reload(next);
    expect(runtime.statuses()).toContainEqual({
      name: "slow",
      transport: "stdio",
      state: "failed",
      code: "timeout",
      detail: "connection timed out",
      resolution: "Check the server, then run /mcp reload slow.",
      usingPrevious: false,
    });
    await runtime.close();
  });

  test("rejects only a colliding candidate at activation", async () => {
    const runtime = createMcpRuntime(config({}), {
      root: "/repo",
      connectServer: async (name) => client("search", [], name),
    });
    const next = config({ "one-two": stdio("one"), one_two: stdio("two") });
    await runtime.reload(next);
    await runtime.activatePending();
    expect(runtime.statuses()).toContainEqual({
      name: "one-two",
      transport: "stdio",
      state: "connected",
    });
    expect(runtime.statuses()).toContainEqual(
      expect.objectContaining({ name: "one_two", state: "failed", code: "tool_collision" }),
    );
    await runtime.close();
  });
});
