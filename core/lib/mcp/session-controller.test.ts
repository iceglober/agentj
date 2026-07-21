import { describe, expect, test } from "bun:test";
import { mcpConfigSchema } from ".";
import type { McpRuntimeStatus } from "./runtime";
import { createMcpSessionController } from "./session-controller";

const issue = { name: "broken", detail: "bad config", resolution: "fix it" };

describe("createMcpSessionController", () => {
  test("overlays invalid config status and skips invalid servers on start", async () => {
    const reloads: unknown[][] = [];
    const published: McpRuntimeStatus[] = [];
    const controller = createMcpSessionController({
      initial: { mcp: mcpConfigSchema.parse({}), issues: [issue] },
      runtime: {
        statuses: () => [
          { name: "broken", transport: "http", state: "connected" },
          { name: "healthy", transport: "http", state: "connected" },
        ],
        reload: async (...args) => {
          reloads.push(args);
        },
      },
      load: async () => ({ mcp: mcpConfigSchema.parse({}), issues: [] }),
      authorizeHttp: async () => ({ ok: true }),
      onStatus: (status) => published.push(status),
    });

    await controller.start();
    expect(reloads[0]?.[2]).toEqual({ skip: ["broken"] });
    expect(controller.statuses()).toEqual([
      { name: "healthy", transport: "http", state: "connected" },
      {
        name: "broken",
        transport: "unknown",
        state: "failed",
        code: "invalid_config",
        detail: "bad config",
        resolution: "fix it",
        usingPrevious: true,
      },
    ]);
    expect(published).toHaveLength(1);
  });

  test("reload refreshes config and authorization validates transport before dispatch", async () => {
    const mcp = mcpConfigSchema.parse({
      servers: {
        web: { transport: "http", url: "https://example.com/mcp" },
        local: { transport: "stdio", command: "server" },
      },
    });
    const authorized: string[] = [];
    const controller = createMcpSessionController({
      initial: { mcp: mcpConfigSchema.parse({}), issues: [issue] },
      runtime: { statuses: () => [], reload: async () => {} },
      load: async () => ({ mcp, issues: [] }),
      authorizeHttp: async (name) => {
        authorized.push(name);
        return { ok: true };
      },
    });

    await controller.reload("web");
    expect(controller.statuses()).toEqual([]);
    expect(await controller.authorize("missing")).toEqual({
      ok: false,
      reason: "no MCP server named missing is configured",
    });
    expect(await controller.authorize("local")).toEqual({
      ok: false,
      reason: "local uses stdio; OAuth applies to HTTP servers",
    });
    expect(await controller.authorize("web")).toEqual({ ok: true });
    expect(authorized).toEqual(["web"]);
  });
});
