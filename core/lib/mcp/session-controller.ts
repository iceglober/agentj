import type { McpConfigIssue } from "../config";
import type { McpConfig, McpServerConfig } from ".";
import type { McpOAuthFlowResult } from "./oauth";
import type { McpRuntime, McpRuntimeStatus } from "./runtime";

type HttpServerConfig = Extract<McpServerConfig, { transport: "http" }>;

export interface McpSessionConfig {
  mcp: McpConfig;
  issues: McpConfigIssue[];
}

export const createMcpSessionController = (options: {
  initial: McpSessionConfig;
  runtime: Pick<McpRuntime, "reload" | "statuses">;
  load(): Promise<McpSessionConfig>;
  authorizeHttp(
    name: string,
    server: HttpServerConfig,
    hooks?: { onAuthorizationUrl?(url: string): void },
  ): Promise<McpOAuthFlowResult>;
  onStatus?(status: McpRuntimeStatus): void;
}) => {
  let current = options.initial;

  const invalidNames = (): Set<string> =>
    new Set(current.issues.filter(({ name }) => name !== "configuration").map(({ name }) => name));
  const issueStatuses = (): McpRuntimeStatus[] => {
    const runtimeStatuses = options.runtime.statuses();
    return current.issues.map((issue) => ({
      name: issue.name,
      transport: "unknown",
      state: "failed",
      code: "invalid_config",
      detail: issue.detail,
      resolution: issue.resolution,
      usingPrevious: runtimeStatuses.some(
        (status) =>
          status.name === issue.name &&
          (status.state === "connected" ||
            status.state === "ready" ||
            (status.state === "failed" && status.usingPrevious)),
      ),
    }));
  };
  const publishIssues = (): void => {
    for (const status of issueStatuses()) options.onStatus?.(status);
  };
  const apply = async (config: McpSessionConfig, name?: string): Promise<void> => {
    current = config;
    publishIssues();
    await options.runtime.reload(config.mcp, name, { skip: [...invalidNames()] });
  };

  return {
    start: () => apply(current),
    reload: async (name?: string) => apply(await options.load(), name),
    statuses: (): readonly McpRuntimeStatus[] => {
      const invalid = invalidNames();
      return [
        ...options.runtime.statuses().filter(({ name }) => !invalid.has(name)),
        ...issueStatuses(),
      ];
    },
    authorize: async (
      name: string,
      hooks?: { onAuthorizationUrl?(url: string): void },
    ): Promise<McpOAuthFlowResult> => {
      const latest = await options.load();
      const server = latest.mcp.servers[name];
      if (!server) return { ok: false, reason: `no MCP server named ${name} is configured` };
      if (server.transport !== "http") {
        return { ok: false, reason: `${name} uses stdio; OAuth applies to HTTP servers` };
      }
      return options.authorizeHttp(name, server, hooks);
    },
  };
};
