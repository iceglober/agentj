import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { mcpServerConfigSchema } from ".";
import {
  connectModelContextProtocolServer,
  resolveMcpTransportConfig,
} from "./model-context-protocol-adapter";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true })));
});

describe("resolveMcpTransportConfig", () => {
  test("uses safe stdio inheritance and resolves mapped environment values", () => {
    const config = mcpServerConfigSchema.parse({
      transport: "stdio",
      command: "server",
      env: { STATIC: "value" },
      envFrom: { TOKEN: "SOURCE_TOKEN" },
    });
    const resolved = resolveMcpTransportConfig(config, {
      SOURCE_TOKEN: "secret",
      SHOULD_NOT_BE_INHERITED: "private",
      PATH: "/bin",
    });
    expect(resolved.env).toMatchObject({ STATIC: "value", TOKEN: "secret" });
    expect(resolved.env?.PATH).toBeString();
    expect(resolved.env).not.toHaveProperty("SHOULD_NOT_BE_INHERITED");
  });

  test("maps HTTP headers without leaking missing secret values", () => {
    const config = mcpServerConfigSchema.parse({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { "X-Static": "value" },
      headersFromEnv: { Authorization: "MCP_AUTH" },
    });
    expect(resolveMcpTransportConfig(config, { MCP_AUTH: "Bearer secret" })).toEqual({
      headers: { "X-Static": "value", Authorization: "Bearer secret" },
    });
    expect(() => resolveMcpTransportConfig(config, {})).toThrow(
      "MCP HTTP server requires environment variable MCP_AUTH",
    );
  });
});

describe("connectModelContextProtocolServer", () => {
  test("connects to a real stdio server and supports tools, resources, cancellation metadata, and close", async () => {
    const fixture = join(process.cwd(), `.agentj-mcp-fixture-${crypto.randomUUID()}.ts`);
    fixtures.push(fixture);
    await writeFile(
      fixture,
      `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo text",
  inputSchema: { text: z.string() },
}, async ({ text }) => ({ content: [{ type: "text", text: "echo:" + text }] }));
server.registerResource("guide", "docs://guide", {
  description: "Fixture guide",
  mimeType: "text/plain",
}, async () => ({ contents: [{ uri: "docs://guide", text: "guide body" }] }));
await server.connect(new StdioServerTransport());
`,
    );

    const client = await connectModelContextProtocolServer(
      "fixture",
      mcpServerConfigSchema.parse({
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      }),
      { root: process.cwd() },
    );
    expect(client.capabilities).toEqual({ tools: true, resources: true, prompts: false });
    const tools = await client.listTools();
    expect(tools.items[0]).toMatchObject({ name: "echo", description: "Echo text" });
    expect(tools.items[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
    const called = await client.callTool("echo", { text: "hello" });
    expect(called.content).toEqual([{ type: "text", text: "echo:hello" }]);
    const resources = await client.listResources();
    expect(resources.items).toEqual([
      {
        uri: "docs://guide",
        name: "guide",
        description: "Fixture guide",
        mimeType: "text/plain",
      },
    ]);
    expect(await client.readResource("docs://guide")).toEqual({
      contents: [{ uri: "docs://guide", text: "guide body" }],
    });
    await client.close();
    await client.close();
  });

  test("connects over Streamable HTTP and sends configured headers", async () => {
    const authorizationHeaders: Array<string | null> = [];
    const http = Bun.serve({
      port: 0,
      async fetch(request) {
        authorizationHeaders.push(request.headers.get("authorization"));
        const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
        server.registerTool(
          "greet",
          { description: "Greet", inputSchema: { name: z.string() } },
          async ({ name }) => ({ content: [{ type: "text", text: `hello ${name}` }] }),
        );
        const transport = new WebStandardStreamableHTTPServerTransport();
        await server.connect(transport);
        return transport.handleRequest(request);
      },
    });

    try {
      const client = await connectModelContextProtocolServer(
        "http-fixture",
        mcpServerConfigSchema.parse({
          transport: "http",
          url: `http://127.0.0.1:${http.port}/mcp`,
          headers: { Authorization: "Bearer test-token" },
        }),
        { root: process.cwd() },
      );
      const tools = await client.listTools();
      expect(tools.items.map((tool) => tool.name)).toEqual(["greet"]);
      expect(await client.callTool("greet", { name: "agentj" })).toMatchObject({
        content: [{ type: "text", text: "hello agentj" }],
      });
      expect(authorizationHeaders).not.toContain(null);
      expect(authorizationHeaders).toContain("Bearer test-token");
      await client.close();
    } finally {
      http.stop(true);
    }
  });
});
