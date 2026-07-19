import type { AgentMode, ExternalAgentTools } from "../agent";
import {
  connectMcpServer,
  createMcpExternalTools,
  createMcpSnapshot,
  getMcpPrompt,
  listMcpPrompts,
  type McpChildConnection,
  type McpConfig,
  type McpPromptCatalogEntry,
  type McpPromptResult,
  type McpServerConnection,
  type McpServerConnector,
  type McpSnapshot,
  McpToolCollisionError,
} from ".";

export type McpFailureCode =
  | "invalid_config"
  | "authentication_failed"
  | "command_not_found"
  | "timeout"
  | "tool_collision"
  | "connection_failed";

type McpStatusIdentity = { name: string; transport: "http" | "stdio" | "unknown" };

export type McpRuntimeStatus = McpStatusIdentity &
  (
    | { state: "connecting" }
    | { state: "ready"; detail: string }
    | { state: "connected" }
    | {
        state: "failed";
        code: McpFailureCode;
        detail: string;
        resolution?: string;
        usingPrevious: boolean;
      }
  );

export interface McpRuntime {
  reload(config: McpConfig, name?: string, options?: { skip?: readonly string[] }): Promise<void>;
  /** Apply successful reloads between foreground turns. */
  activatePending(): Promise<boolean>;
  snapshot(): McpSnapshot;
  prompts(): readonly McpPromptCatalogEntry[];
  getPrompt(server: string, prompt: string, args: Record<string, string>): Promise<McpPromptResult>;
  statuses(): readonly McpRuntimeStatus[];
  /** Create a child-scoped capability lease. Only opted-in servers are exposed. */
  createChildConnection(root: string, signal?: AbortSignal): Promise<McpChildConnection>;
  close(): Promise<void>;
}

export interface McpRuntimeOptions {
  root: string;
  connectServer: McpServerConnector;
  onStatus?(status: McpRuntimeStatus): void;
  timeoutMs?: number;
  /** OAuth credential storage passed through to every server connect. */
  oauth?: import("./oauth").McpOAuthStorage;
  /** Persists over-cap MCP results in full so truncation never loses data. */
  spill?: import("../truncation").SpillWriter;
}

const EMPTY_TOOLS = { plan: { tools: {} }, build: { tools: {} } } as Readonly<
  Record<AgentMode, ExternalAgentTools>
>;
const DEFAULT_TIMEOUT_MS = 15_000;

const errorChain = (error: unknown): unknown[] => {
  const errors: unknown[] = [];
  let current = error;
  while (current && errors.length < 5) {
    errors.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return errors;
};

const classifyFailure = (name: string, error: unknown, timedOut: boolean) => {
  const chain = errorChain(error);
  const message = chain
    .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
    .join(" ");
  // Codes are strings from Node (ENOENT, REQUEST_TIMEOUT) but numeric HTTP
  // statuses from the MCP SDK's StreamableHTTPError, whose message omits them.
  const codes = chain
    .map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as { code?: unknown }).code : undefined,
    )
    .filter((value) => typeof value === "string" || typeof value === "number");
  const code = codes.find((value) => typeof value === "string");
  const statusCode = codes.find((value) => typeof value === "number");
  const missingVariable = message.match(
    /requires environment variable ([A-Za-z_][A-Za-z0-9_]*)/u,
  )?.[1];
  if (missingVariable) {
    return {
      code: "invalid_config" as const,
      detail: `missing environment variable ${missingVariable}`,
      resolution: `Set ${missingVariable} in AgentJ's environment, then restart this session.`,
    };
  }
  if (
    timedOut ||
    code === "REQUEST_TIMEOUT" ||
    /\b(timeout|timed out|aborterror)\b/iu.test(message)
  ) {
    return {
      code: "timeout" as const,
      detail: "connection timed out",
      resolution: `Check the server, then run /mcp reload ${name}.`,
    };
  }
  if (code === "ENOENT" || /\bENOENT\b|command not found/iu.test(message)) {
    return {
      code: "command_not_found" as const,
      detail: "server command was not found",
      resolution: `Update mcp.servers.${name}.command, then run /mcp reload ${name}.`,
    };
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /\b(401|403|unauthorized|forbidden)\b/iu.test(message)
  ) {
    return {
      code: "authentication_failed" as const,
      detail: "authentication was rejected",
      resolution: `Run /mcp auth ${name}; reload is automatic.`,
    };
  }
  if (error instanceof McpToolCollisionError || /MCP tool name collision/iu.test(message)) {
    return {
      code: "tool_collision" as const,
      detail: "tool names collide after canonicalization",
      resolution: `Adjust tool selection for ${name}, then run /mcp reload ${name}.`,
    };
  }
  return {
    code: "connection_failed" as const,
    detail: "connection failed",
    resolution: `Check the server, then run /mcp reload ${name}.`,
  };
};

/** One small owner for live MCP state. Connections stage off-side and swap only between turns. */
export function createMcpRuntime(initialConfig: McpConfig, options: McpRuntimeOptions): McpRuntime {
  let config = initialConfig;
  let active = new Map<string, McpServerConnection>();
  const pending = new Map<string, McpServerConnection | null>();
  const status = new Map<string, McpRuntimeStatus>();
  const attempts = new Map<string, { id: number; controller: AbortController }>();
  let attemptId = 0;
  let closed = false;
  let activeMaxOutputChars = initialConfig.maxOutputChars;
  let pendingMaxOutputChars = initialConfig.maxOutputChars;
  let current: McpSnapshot = Object.freeze({ version: 0, externalTools: EMPTY_TOOLS });

  const publish = (next: McpRuntimeStatus): void => {
    status.set(next.name, next);
    options.onStatus?.(next);
  };

  const reloadOne = async (name: string): Promise<void> => {
    const serverConfig = config.servers[name];
    attempts.get(name)?.controller.abort();
    const staleCandidate = pending.get(name);
    if (staleCandidate) await staleCandidate.client.close().catch(() => undefined);
    pending.delete(name);
    if (!serverConfig) {
      pending.set(name, null);
      const transport = active.get(name)?.config.transport ?? "stdio";
      publish({ name, transport, state: "ready", detail: "will be removed on the next turn" });
      return;
    }

    attemptId += 1;
    const id = attemptId;
    const controller = new AbortController();
    attempts.set(name, { id, controller });
    publish({ name, transport: serverConfig.transport, state: "connecting" });
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const candidate = await connectMcpServer(name, serverConfig, {
        root: options.root,
        connectServer: options.connectServer,
        signal: controller.signal,
        timeoutMs,
        ...(options.oauth ? { oauth: options.oauth } : {}),
      });
      if (closed || attempts.get(name)?.id !== id) {
        await candidate.client.close().catch(() => undefined);
        return;
      }
      pending.set(name, candidate);
      publish({
        name,
        transport: serverConfig.transport,
        state: "ready",
        detail: "available on the next turn",
      });
    } catch (error) {
      if (closed || attempts.get(name)?.id !== id) return;
      const failure = classifyFailure(name, error, timedOut);
      publish({
        name,
        transport: serverConfig.transport,
        state: "failed",
        ...failure,
        usingPrevious: active.has(name),
      });
    } finally {
      clearTimeout(timer);
      if (attempts.get(name)?.id === id) attempts.delete(name);
    }
  };

  return {
    async reload(nextConfig, name, reloadOptions) {
      if (closed) return;
      config = nextConfig;
      pendingMaxOutputChars = nextConfig.maxOutputChars;
      const skipped = new Set(reloadOptions?.skip ?? []);
      const names = (
        name
          ? [name]
          : [
              ...new Set([...Object.keys(nextConfig.servers), ...active.keys(), ...pending.keys()]),
            ].sort()
      ).filter((candidate) => !skipped.has(candidate));
      await Promise.all(names.map(reloadOne));
    },

    async activatePending() {
      if (closed || (pending.size === 0 && pendingMaxOutputChars === activeMaxOutputChars))
        return false;
      const next = new Map(active);
      const retired: McpServerConnection[] = [];
      let changed = false;
      for (const name of [...pending.keys()].sort()) {
        const candidate = pending.get(name);
        const previous = next.get(name);
        if (candidate === null) {
          if (previous) {
            next.delete(name);
            retired.push(previous);
            changed = true;
          }
          pending.delete(name);
          status.delete(name);
          continue;
        }
        if (!candidate) continue;
        const test = new Map(next);
        test.set(name, candidate);
        try {
          createMcpSnapshot(
            [...test.values()],
            pendingMaxOutputChars,
            current.version + 1,
            options.spill,
          );
          next.set(name, candidate);
          if (previous && previous !== candidate) retired.push(previous);
          pending.delete(name);
          publish({ name, transport: candidate.config.transport, state: "connected" });
          changed = true;
        } catch (error) {
          pending.delete(name);
          await candidate.client.close().catch(() => undefined);
          const failure = classifyFailure(name, error, false);
          publish({
            name,
            transport: candidate.config.transport,
            state: "failed",
            ...failure,
            usingPrevious: Boolean(previous),
          });
        }
      }
      if (changed || pendingMaxOutputChars !== activeMaxOutputChars) {
        active = next;
        activeMaxOutputChars = pendingMaxOutputChars;
        current = createMcpSnapshot(
          [...active.values()],
          activeMaxOutputChars,
          current.version + 1,
          options.spill,
        );
      }
      await Promise.allSettled(retired.map((server) => server.client.close()));
      return changed;
    },

    snapshot() {
      return current;
    },

    prompts() {
      return listMcpPrompts([...active.values()]);
    },

    async getPrompt(server, prompt, args) {
      return await getMcpPrompt([...active.values()], server, prompt, args);
    },

    async createChildConnection(root, signal) {
      if (closed) throw new Error("MCP runtime is closed");
      // Shared HTTP states are a read-only view of the primary catalog. They
      // cannot reload, close, or consume list-change notifications. Isolated
      // stdio states are connected under the child's worktree and owned only by
      // this lease, so concurrent children never share lifecycle state.
      const shared = [...active.values()].filter(
        (state) => state.config.transport === "http" && state.config.inherit === "shared",
      );
      const isolatedConfigs = Object.entries(config.servers)
        .filter(
          (entry): entry is [string, McpConfig["servers"][string]] =>
            entry[1]?.transport === "stdio" && entry[1].inherit === "isolated",
        )
        .sort(([left], [right]) => left.localeCompare(right));
      const isolated: McpServerConnection[] = [];
      try {
        for (const [name, serverConfig] of isolatedConfigs) {
          isolated.push(
            await connectMcpServer(name, serverConfig, {
              root,
              connectServer: options.connectServer,
              ...(signal ? { signal } : {}),
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              ...(options.oauth ? { oauth: options.oauth } : {}),
            }),
          );
        }
        const states = [...shared, ...isolated].sort((left, right) =>
          left.name.localeCompare(right.name),
        );
        return {
          externalTools: createMcpExternalTools(states, activeMaxOutputChars, options.spill, {
            readonlyCatalog: shared,
          }),
          async close() {
            await Promise.allSettled(isolated.map((state) => state.client.close()));
          },
        };
      } catch (error) {
        await Promise.allSettled(isolated.map((state) => state.client.close()));
        throw error;
      }
    },

    statuses() {
      const names = new Set([...Object.keys(config.servers), ...active.keys(), ...status.keys()]);
      return [...names].sort().map(
        (name) =>
          status.get(name) ?? {
            name,
            transport:
              config.servers[name]?.transport ?? active.get(name)?.config.transport ?? "stdio",
            state: "connecting" as const,
          },
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const attempt of attempts.values()) attempt.controller.abort();
      attempts.clear();
      const connections = new Set<McpServerConnection>(active.values());
      for (const candidate of pending.values()) if (candidate) connections.add(candidate);
      active.clear();
      pending.clear();
      await Promise.allSettled([...connections].map((server) => server.client.close()));
    },
  };
}
