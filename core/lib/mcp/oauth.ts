import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type SecretStore, SecretStoreUnavailableError } from "../secrets";

/**
 * OAuth 2.1 for HTTP MCP servers (Linear, Notion, …) that advertise it over a
 * 401 WWW-Authenticate challenge. The SDK owns the protocol (discovery,
 * dynamic client registration, PKCE, refresh); this module owns what the SDK
 * delegates: durable credential storage (keyring), the loopback redirect that
 * catches the browser callback, and the decision of when a flow may interact.
 *
 * Background connects never open a browser: they attach a provider only when
 * tokens already exist (so refresh works), and surface a typed 401 error
 * otherwise — the runtime classifies it and points at `/mcp auth <server>`.
 */

const OAUTH_SECRET_SERVICE = "agentj-mcp-oauth";

export interface McpOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export interface McpOAuthStorage {
  load(server: string): Promise<McpOAuthState | undefined>;
  save(server: string, state: McpOAuthState): Promise<void>;
  clear(server: string): Promise<void>;
}

/** Keyring-backed storage: one JSON payload per server, values never logged.
 *  Reads swallow an unavailable keyring (a background connect then behaves
 *  like the unauthenticated case); writes propagate so a flow fails loudly. */
export const createKeyringMcpOAuthStorage = (store: SecretStore): McpOAuthStorage => ({
  async load(server) {
    let raw: string | undefined;
    try {
      raw = await store.get(OAUTH_SECRET_SERVICE, server);
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) return undefined;
      throw error;
    }
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as McpOAuthState;
    } catch {
      return undefined;
    }
  },
  async save(server, state) {
    await store.set(OAUTH_SECRET_SERVICE, server, JSON.stringify(state));
  },
  async clear(server) {
    await store.delete(OAUTH_SECRET_SERVICE, server);
  },
});

/** Message deliberately contains "401 unauthorized" so the runtime's existing
 *  failure classifier maps it to authentication_failed → "Run /mcp auth". */
export class McpAuthorizationRequiredError extends Error {
  constructor(server: string) {
    super(`MCP server ${server} requires interactive authorization (401 unauthorized)`);
    this.name = "McpAuthorizationRequiredError";
  }
}

export interface McpOAuthRedirect {
  url: string;
  state: string;
  onAuthorize(url: URL): void | Promise<void>;
}

/** The SDK reads a missing redirectUrl as a non-interactive grant (it then
 *  calls the token endpoint with no authorization code, which cannot work
 *  here). Background providers declare this placeholder instead so token
 *  refresh takes its normal path; anything that actually needs the browser
 *  lands in redirectToAuthorization, which throws the typed 401. The URL
 *  never serves traffic. */
const BACKGROUND_REDIRECT_PLACEHOLDER = "http://127.0.0.1/agentj-oauth-unavailable";

/** SDK-facing provider. With `redirect` it can run the full interactive flow;
 *  without, it only serves saved credentials (token attach + refresh) and
 *  turns any interactive requirement into McpAuthorizationRequiredError. */
export const createMcpOAuthProvider = (args: {
  server: string;
  storage: McpOAuthStorage;
  redirect?: McpOAuthRedirect;
}): OAuthClientProvider => {
  const merge = async (patch: McpOAuthState): Promise<void> => {
    const current = (await args.storage.load(args.server)) ?? {};
    await args.storage.save(args.server, { ...current, ...patch });
  };
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return args.redirect?.url ?? BACKGROUND_REDIRECT_PLACEHOLDER;
    },
    get clientMetadata() {
      return {
        client_name: "agentj",
        redirect_uris: args.redirect ? [args.redirect.url] : [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    async clientInformation() {
      return (await args.storage.load(args.server))?.clientInformation;
    },
    async saveClientInformation(clientInformation) {
      await merge({ clientInformation });
    },
    async tokens() {
      return (await args.storage.load(args.server))?.tokens;
    },
    async saveTokens(tokens) {
      await merge({ tokens });
    },
    async redirectToAuthorization(authorizationUrl) {
      if (!args.redirect) throw new McpAuthorizationRequiredError(args.server);
      await args.redirect.onAuthorize(authorizationUrl);
    },
    async saveCodeVerifier(codeVerifier) {
      await merge({ codeVerifier });
    },
    async codeVerifier() {
      const verifier = (await args.storage.load(args.server))?.codeVerifier;
      if (!verifier) throw new Error("No PKCE code verifier saved for this authorization.");
      return verifier;
    },
    async invalidateCredentials(scope) {
      if (scope === "all") {
        await args.storage.clear(args.server);
        return;
      }
      const current = await args.storage.load(args.server);
      if (!current) return;
      if (scope === "client") delete current.clientInformation;
      if (scope === "tokens") delete current.tokens;
      if (scope === "verifier") delete current.codeVerifier;
      await args.storage.save(args.server, current);
    },
  };
  if (args.redirect) {
    const state = args.redirect.state;
    provider.state = () => state;
  }
  return provider;
};

/** Best-effort platform browser open; the flow also surfaces the URL as text. */
export const openInBrowser = async (url: URL): Promise<boolean> => {
  const command =
    process.platform === "darwin"
      ? ["open", url.toString()]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url.toString()]
        : ["xdg-open", url.toString()];
  try {
    const child = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
};

export interface McpOAuthFlowOptions {
  storage: McpOAuthStorage;
  /** Static headers from the server config ride along on every request. */
  headers?: Record<string, string>;
  /** Defaults to the platform opener; the URL is also reported as text. */
  openBrowser?(url: URL): Promise<boolean>;
  /** Fires with the authorization URL so a UI can show it (or when the
   *  browser could not be opened). */
  onAuthorizationUrl?(url: string): void;
  /** How long to wait for the browser round-trip. Default 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type McpOAuthFlowResult = { ok: true } | { ok: false; reason: string };

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Interactive authorization for one HTTP MCP server: loopback listener →
 * browser → code callback → token exchange. Clears prior credentials first so
 * the dynamic client registration carries this flow's redirect URL.
 */
export async function runMcpOAuthFlow(
  server: string,
  serverUrl: string,
  options: McpOAuthFlowOptions,
): Promise<McpOAuthFlowResult> {
  await options.storage.clear(server);
  const state = crypto.randomUUID();

  let resolveCallback: (result: { code?: string; error?: string; state?: string }) => void;
  const callbackArrived = new Promise<{ code?: string; error?: string; state?: string }>(
    (resolve) => {
      resolveCallback = resolve;
    },
  );
  const loopback = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      resolveCallback({
        code: url.searchParams.get("code") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
      });
      return new Response(
        "<!doctype html><title>agentj</title><body>agentj is authorized — you can close this tab.</body>",
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });

  const provider = createMcpOAuthProvider({
    server,
    storage: options.storage,
    redirect: {
      url: `http://127.0.0.1:${loopback.port}/callback`,
      state,
      onAuthorize: async (authorizationUrl) => {
        const opened = await (options.openBrowser ?? openInBrowser)(authorizationUrl);
        if (!opened || options.onAuthorizationUrl) {
          options.onAuthorizationUrl?.(authorizationUrl.toString());
        }
      },
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider,
    ...(options.headers ? { requestInit: { headers: options.headers } } : {}),
  });
  const client = new Client({ name: `agentj-${server}-auth`, version: "0.1.0" });

  try {
    try {
      await client.connect(transport, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      // The server accepted us without a browser round-trip (saved tokens or
      // static headers already suffice).
      return { ok: true };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        return { ok: false, reason: errorText(error) };
      }
    }

    const timeoutMs = options.timeoutMs ?? 300_000;
    const callback = await new Promise<{ code?: string; error?: string; state?: string } | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve(null);
        };
        // A listener added to an already-aborted signal never fires.
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        void callbackArrived.then((result) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        });
      },
    );
    if (!callback) return { ok: false, reason: "authorization timed out or was aborted" };
    if (callback.error) return { ok: false, reason: `authorization failed: ${callback.error}` };
    if (!callback.code) return { ok: false, reason: "authorization callback carried no code" };
    if (callback.state !== state) return { ok: false, reason: "authorization state mismatch" };

    await transport.finishAuth(callback.code);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    loopback.stop(true);
  }
}
