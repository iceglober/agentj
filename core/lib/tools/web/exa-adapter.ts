import { type McpServerClient, normalizeMcpToolResult } from "../../mcp";
import { connectModelContextProtocolServer } from "../../mcp/model-context-protocol-adapter";
import type { WebSearch } from ".";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export interface ExaWebSearchOptions {
  /** Injectable for tests; production uses the shared MCP transport adapter. */
  connect?: () => Promise<McpServerClient>;
  maxOutputChars?: number;
}

/**
 * Anonymous Exa MCP search. This is deliberately a WebSearch implementation,
 * not a configured/user-visible MCP server: its protocol and lifecycle are an
 * implementation detail of the built-in, provider-neutral web_search tool.
 */
export const createExaWebSearch = (
  options: ExaWebSearchOptions = {},
): WebSearch & { close(): Promise<void> } => {
  let client: Promise<McpServerClient> | undefined;
  const connect =
    options.connect ??
    (() =>
      connectModelContextProtocolServer(
        "web-search",
        {
          transport: "http",
          url: EXA_MCP_URL,
          headers: {},
          headersFromEnv: {},
          inherit: "none",
          tools: { plan: [], build: [], direct: [] },
          resources: { plan: [], build: [] },
        },
        { root: process.cwd(), timeoutMs: 15_000 },
      ));

  return {
    async search({ query, limit, signal }) {
      client ??= connect();
      const result = await (await client).callTool(
        "web_search_exa",
        { query, numResults: limit, contextMaxCharacters: 20_000 },
        signal,
      );
      return normalizeMcpToolResult(result, options.maxOutputChars);
    },
    async close() {
      const current = client;
      client = undefined;
      if (current) await (await current).close();
    },
  };
};
