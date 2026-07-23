import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type SecretStore, SecretStoreUnavailableError } from "../secrets";
import { mcpServerConfigSchema } from ".";
import { connectModelContextProtocolServer } from "./model-context-protocol-adapter";
import {
  createKeyringMcpOAuthStorage,
  createMcpOAuthProvider,
  McpAuthorizationRequiredError,
  type McpOAuthStorage,
  runMcpOAuthFlow,
} from "./oauth";

const memoryStore = (): SecretStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    async get(service, account) {
      return values.get(`${service}/${account}`);
    },
    async set(service, account, secret) {
      values.set(`${service}/${account}`, secret);
    },
    async delete(service, account) {
      return values.delete(`${service}/${account}`);
    },
  };
};

const memoryStorage = (): McpOAuthStorage => createKeyringMcpOAuthStorage(memoryStore());

describe("keyring OAuth storage", () => {
  test("round-trips state and clears it", async () => {
    const storage = memoryStorage();
    await storage.save("linear", { tokens: { access_token: "at", token_type: "Bearer" } });
    expect((await storage.load("linear"))?.tokens?.access_token).toBe("at");
    await storage.clear("linear");
    expect(await storage.load("linear")).toBeUndefined();
  });

  test("an unavailable keyring reads as unauthorized, not an error", async () => {
    const storage = createKeyringMcpOAuthStorage({
      async get() {
        throw new SecretStoreUnavailableError();
      },
      async set() {
        throw new SecretStoreUnavailableError();
      },
      async delete() {
        throw new SecretStoreUnavailableError();
      },
    });
    expect(await storage.load("linear")).toBeUndefined();
    await expect(storage.save("linear", {})).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  test("corrupt payloads read as absent", async () => {
    const store = memoryStore();
    await store.set("glorious-mcp-oauth", "bad", "not json");
    expect(await createKeyringMcpOAuthStorage(store).load("bad")).toBeUndefined();
  });
});

describe("OAuth provider", () => {
  test("background providers refuse interactive authorization with a 401-classified error", async () => {
    const provider = createMcpOAuthProvider({ server: "linear", storage: memoryStorage() });
    // A real (placeholder) redirectUrl keeps the SDK on the authorization-code
    // path so refresh works; interactivity is refused at redirect time instead.
    expect(provider.redirectUrl).toContain("127.0.0.1");
    await expect(
      Promise.resolve(provider.redirectToAuthorization(new URL("https://auth.example/a"))),
    ).rejects.toBeInstanceOf(McpAuthorizationRequiredError);
    try {
      await provider.redirectToAuthorization(new URL("https://auth.example/a"));
    } catch (error) {
      expect(String(error)).toMatch(/401 unauthorized/i);
    }
  });

  test("saves merge instead of clobbering sibling credentials", async () => {
    const storage = memoryStorage();
    const provider = createMcpOAuthProvider({ server: "s", storage });
    await provider.saveClientInformation?.({ client_id: "c1", redirect_uris: [] });
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.saveCodeVerifier("verifier");
    const state = await storage.load("s");
    expect(state?.clientInformation?.client_id).toBe("c1");
    expect(state?.tokens?.access_token).toBe("at");
    expect(state?.codeVerifier).toBe("verifier");
    expect(await provider.codeVerifier()).toBe("verifier");
  });
});

/** A minimal OAuth 2.1 authorization server + Bearer-protected MCP endpoint:
 *  requests carrying a token minted by the refresh grant reach a real MCP
 *  server; everything else gets the 401 challenge. */
const createFakeOAuthServer = (
  options: { callbackState?: "echo" | "wrong"; authorize?: "grant" | "deny" } = {},
) => {
  const seen = {
    codeChallenge: "",
    registeredRedirects: [] as string[],
    tokenRequests: [] as URLSearchParams[],
    authorizeRequests: 0,
  };
  let origin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/mcp" || url.pathname === "/") {
        if (request.headers.get("authorization") === "Bearer refreshed-access-token") {
          const mcp = new McpServer({ name: "fake-mcp", version: "1.0.0" });
          mcp.registerTool("ping", { description: "Ping" }, async () => ({
            content: [{ type: "text", text: "pong" }],
          }));
          const transport = new WebStandardStreamableHTTPServerTransport();
          await mcp.connect(transport);
          return transport.handleRequest(request);
        }
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const body = (await request.json()) as { redirect_uris?: string[] };
        seen.registeredRedirects = body.redirect_uris ?? [];
        return Response.json({
          client_id: "fake-client",
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname === "/authorize") {
        seen.authorizeRequests += 1;
        seen.codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        if (options.authorize === "deny") {
          redirect.searchParams.set("error", "access_denied");
        } else {
          redirect.searchParams.set("code", "fake-code");
        }
        const state = url.searchParams.get("state");
        if (state) {
          redirect.searchParams.set(
            "state",
            options.callbackState === "wrong" ? "not-the-state" : state,
          );
        }
        return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const params = new URLSearchParams(await request.text());
        seen.tokenRequests.push(params);
        if (params.get("grant_type") === "refresh_token") {
          if (params.get("refresh_token") !== "fake-refresh-token") {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json({
            access_token: "refreshed-access-token",
            token_type: "Bearer",
            refresh_token: "fake-refresh-token",
            expires_in: 3600,
          });
        }
        if (params.get("code") !== "fake-code") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: "fake-access-token",
          token_type: "Bearer",
          refresh_token: "fake-refresh-token",
          expires_in: 3600,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { server, seen, url: `${origin}/mcp` };
};

/** Stands in for the human: follow the authorize redirect back to the loopback. */
const headlessBrowser = async (authorizationUrl: URL): Promise<boolean> => {
  const authorize = await fetch(authorizationUrl, { redirect: "manual" });
  const location = authorize.headers.get("Location");
  if (!location) return false;
  await fetch(location);
  return true;
};

describe("runMcpOAuthFlow", () => {
  const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  test("full flow: discovery, registration, PKCE exchange, tokens persisted", async () => {
    const fake = createFakeOAuthServer();
    servers.push(fake.server);
    const storage = memoryStorage();
    // Stale credentials from an earlier authorization must not leak into this
    // flow: registration re-runs with the fresh loopback redirect.
    await storage.save("fake", {
      clientInformation: { client_id: "stale-client", redirect_uris: [] },
      tokens: { access_token: "stale-access-token", token_type: "Bearer" },
    });

    const result = await runMcpOAuthFlow("fake", fake.url, {
      storage,
      openBrowser: headlessBrowser,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ ok: true });
    const saved = await storage.load("fake");
    expect(saved?.tokens?.access_token).toBe("fake-access-token");
    expect(saved?.clientInformation?.client_id).toBe("fake-client");
    expect(fake.seen.registeredRedirects[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(fake.seen.codeChallenge.length).toBeGreaterThan(0);
    const token = fake.seen.tokenRequests.at(-1);
    expect(token?.get("grant_type")).toBe("authorization_code");
    expect(token?.get("code_verifier")?.length ?? 0).toBeGreaterThan(0);
    // The loopback listener does not outlive the flow.
    await expect(fetch(fake.seen.registeredRedirects[0] ?? "")).rejects.toThrow();
  });

  test("a denied authorization reports the server's error and saves no tokens", async () => {
    const fake = createFakeOAuthServer({ authorize: "deny" });
    servers.push(fake.server);
    const storage = memoryStorage();

    const result = await runMcpOAuthFlow("fake", fake.url, {
      storage,
      openBrowser: headlessBrowser,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ ok: false, reason: "authorization failed: access_denied" });
    expect((await storage.load("fake"))?.tokens).toBeUndefined();
  });

  test("aborting cancels the callback wait and closes the loopback listener", async () => {
    const fake = createFakeOAuthServer();
    servers.push(fake.server);
    const storage = memoryStorage();
    const abort = new AbortController();
    let callbackUrl = "";

    const result = await runMcpOAuthFlow("fake", fake.url, {
      storage,
      openBrowser: async (authorizationUrl) => {
        // Capture where the browser would land, then walk away: the user
        // abandons the browser and cancels from the terminal instead.
        callbackUrl = authorizationUrl.searchParams.get("redirect_uri") ?? "";
        setTimeout(() => abort.abort(), 50);
        return true;
      },
      timeoutMs: 60_000,
      signal: abort.signal,
    });

    expect(result).toEqual({ ok: false, reason: "authorization timed out or was aborted" });
    expect(callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await storage.load("fake"))?.tokens).toBeUndefined();
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  test("a tampered state parameter fails the flow without saving tokens", async () => {
    const fake = createFakeOAuthServer({ callbackState: "wrong" });
    servers.push(fake.server);
    const storage = memoryStorage();

    const result = await runMcpOAuthFlow("fake", fake.url, {
      storage,
      openBrowser: headlessBrowser,
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/state mismatch/);
    expect((await storage.load("fake"))?.tokens).toBeUndefined();
  });

  test("an unreachable server fails with a reason instead of hanging", async () => {
    const storage = memoryStorage();
    const result = await runMcpOAuthFlow("gone", "http://127.0.0.1:1/mcp", {
      storage,
      openBrowser: async () => true,
      timeoutMs: 2_000,
    });
    expect(result.ok).toBe(false);
  });
});

/** What `glorious run` and interactive startup do: connect with saved
 *  credentials only, never a browser. */
describe("background connects", () => {
  const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  const httpConfig = (url: string) => mcpServerConfigSchema.parse({ transport: "http", url });

  test("refreshes expired tokens and persists the new ones, without a browser", async () => {
    const fake = createFakeOAuthServer();
    servers.push(fake.server);
    const storage = memoryStorage();
    await storage.save("fake", {
      clientInformation: { client_id: "fake-client", redirect_uris: [] },
      tokens: {
        access_token: "stale-access-token",
        token_type: "Bearer",
        refresh_token: "fake-refresh-token",
      },
    });

    const client = await connectModelContextProtocolServer("fake", httpConfig(fake.url), {
      root: process.cwd(),
      oauth: storage,
    });
    try {
      const tools = await client.listTools();
      expect(tools.items.map((tool) => tool.name)).toEqual(["ping"]);
      expect((await storage.load("fake"))?.tokens?.access_token).toBe("refreshed-access-token");
      expect(fake.seen.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
      expect(fake.seen.authorizeRequests).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("a never-authorized server fails with a plain 401 and no authorization traffic", async () => {
    const fake = createFakeOAuthServer();
    servers.push(fake.server);

    const attempt = connectModelContextProtocolServer("fake", httpConfig(fake.url), {
      root: process.cwd(),
      oauth: memoryStorage(),
    });
    await expect(attempt).rejects.toThrow(/Unable to connect MCP server fake/);
    // The SDK reports the 401 as a numeric error code, not message text; the
    // runtime's classifier maps it to authentication_failed from the cause chain.
    const error = await attempt.catch((thrown) => thrown as Error);
    let status: unknown;
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      status ??= (cause as { code?: unknown }).code;
    }
    expect(status).toBe(401);

    expect(fake.seen.authorizeRequests).toBe(0);
    expect(fake.seen.registeredRedirects).toEqual([]);
    expect(fake.seen.tokenRequests).toEqual([]);
  });
});
