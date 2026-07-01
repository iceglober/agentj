// MCP client — connects to the configured servers and exposes their tool lists. Routine runs call
// `connectServers`; it never opens a browser. A server that needs OAuth but has no stored token (or
// an unrefreshable one) surfaces as an UnauthorizedError, which we turn into a notice telling the
// user to run `agentj mcp login <name>` — the session continues with the other servers.
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { hasStaticAuth, type McpServerConfig } from "./config.ts";
import { AgentjOAuthProvider } from "./oauth.ts";

/** A tool as advertised by a server (name + JSON-Schema input), enough to adapt into an AI SDK tool. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface McpConnection {
  server: string;
  client: Client;
  tools: McpToolDef[];
}

/** A remote server config (has a `url`) — the only kind that can need OAuth. */
export type RemoteServerConfig = Extract<McpServerConfig, { transport: "http" | "sse" }>;

export interface ConnectedMcp {
  /** Connected servers. */
  connections: McpConnection[];
  /** Servers that need OAuth (returned 401/403 with no usable token) — offer the user a login. */
  needsAuth: RemoteServerConfig[];
  /** Hard failures (not auth) to surface to the user; never throws. */
  warnings: string[];
  /** Names of servers that hard-failed (timed out / errored) — the caller can stop retrying them. */
  failed: string[];
  /** Disconnect every connected client. Best-effort. */
  close(): Promise<void>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Per-server connect deadline. A stdio server that runs its own browser OAuth (e.g. `mcp-remote`)
 *  never finishes connecting until the user completes — or abandons — the login; without this the
 *  whole startup hangs. Overridable via AGENTJ_MCP_CONNECT_TIMEOUT_MS. */
const CONNECT_TIMEOUT_MS = Number(process.env.AGENTJ_MCP_CONNECT_TIMEOUT_MS) || 30_000;

/** Race a promise against an abort signal (Ctrl-C) and a timeout. The underlying promise is left to
 *  settle on its own; the caller closes the transport to reap a hung child. */
function withDeadline<T>(p: Promise<T>, what: string, signal?: AbortSignal, timeoutMs = CONNECT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s (${what}) — does it need a browser login?`))), timeoutMs);
    const onAbort = () => finish(() => reject(new Error("cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    p.then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
  });
}

function makeTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    Object.assign(env, cfg.env); // declared env wins
    // `stderr: "pipe"` keeps the child's stderr OFF our terminal — the SDK default ("inherit") lets a
    // crashing or chatty server scribble over the TUI and dump a stack trace on exit. We drain it on
    // failure (below) to surface the reason.
    return new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: "pipe" });
  }
  const url = new URL(cfg.url);
  // Static Authorization header wins (Claude Code: no OAuth fallback when a header is set).
  if (hasStaticAuth(cfg)) {
    const requestInit = { headers: cfg.headers };
    return cfg.transport === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
  }
  // Otherwise drive OAuth from stored tokens (non-interactive — no browser during a run).
  const authProvider = new AgentjOAuthProvider(cfg.name, false);
  return cfg.transport === "sse" ? new SSEClientTransport(url, { authProvider }) : new StreamableHTTPClientTransport(url, { authProvider });
}

/** Drain a failed stdio child's piped stderr and fold the last meaningful line into the error, so a
 *  server that crashes on startup (e.g. a missing env var) reports *why* instead of a vague SDK error. */
function stdioFailure(transport: Transport, err: unknown): string {
  let tail = "";
  try {
    const stderr = (transport as StdioClientTransport).stderr as Readable | null;
    let chunk: unknown;
    while (stderr && (chunk = stderr.read()) !== null) tail += String(chunk);
  } catch {
    // best-effort — fall back to the SDK error alone
  }
  const lastLine = tail
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return lastLine ? `${msg(err)} (${lastLine})` : msg(err);
}

/** Connect to one server and list its tools. Throws on failure (UnauthorizedError when it needs
 *  OAuth). Used by `connectServers` and to reconnect a server right after an in-session login. */
export async function connectOne(cfg: McpServerConfig, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpConnection> {
  const client = new Client({ name: "agentj", version: "0.0.0" });
  const transport = makeTransport(cfg);
  try {
    await withDeadline(client.connect(transport), "connect", opts.signal, opts.timeoutMs);
    const { tools } = await withDeadline(client.listTools(), "list tools", opts.signal, opts.timeoutMs);
    return { server: cfg.name, client, tools };
  } catch (err) {
    // Read the child's stderr BEFORE closing the transport tears it down.
    const detail = cfg.transport === "stdio" ? stdioFailure(transport, err) : null;
    await client.close().catch(() => {});
    if (detail) throw new Error(detail); // stdio: enriched, never an UnauthorizedError
    throw err; // remote: preserve UnauthorizedError so connectServers routes it to needsAuth
  }
}

/** Connect to every configured server in parallel. Failures become warnings / needsAuth, not throws.
 *  Each connect is bounded (timeout) and cancellable (signal), so one hung server can't stall startup. */
export async function connectServers(configs: McpServerConfig[], opts: { signal?: AbortSignal } = {}): Promise<ConnectedMcp> {
  const connections: McpConnection[] = [];
  const needsAuth: RemoteServerConfig[] = [];
  const warnings: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    configs.map(async (cfg) => {
      try {
        connections.push(await connectOne(cfg, { signal: opts.signal }));
      } catch (err) {
        if (err instanceof UnauthorizedError && cfg.transport !== "stdio") needsAuth.push(cfg);
        else {
          warnings.push(`MCP "${cfg.name}" failed to connect: ${msg(err)}`);
          failed.push(cfg.name);
        }
      }
    }),
  );

  return {
    connections,
    needsAuth,
    warnings,
    failed,
    close: async () => {
      await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
    },
  };
}
