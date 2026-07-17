import { afterEach, describe, expect, test } from "bun:test";
import { type SecretStore, SecretStoreUnavailableError } from "../secrets";
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
    await store.set("agentj-mcp-oauth", "bad", "not json");
    expect(await createKeyringMcpOAuthStorage(store).load("bad")).toBeUndefined();
  });
});

describe("OAuth provider", () => {
  test("background providers refuse interactive authorization with a 401-classified error", async () => {
    const provider = createMcpOAuthProvider({ server: "linear", storage: memoryStorage() });
    expect(provider.redirectUrl).toBeUndefined();
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

/** A minimal OAuth 2.1 authorization server + 401-only MCP endpoint. */
const createFakeOAuthServer = (options: { callbackState?: "echo" | "wrong" } = {}) => {
  const seen = {
    codeChallenge: "",
    registeredRedirects: [] as string[],
    tokenRequests: [] as URLSearchParams[],
  };
  let origin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/mcp" || url.pathname === "/") {
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
        seen.codeChallenge = url.searchParams.get("code_challenge") ?? "";
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "fake-code");
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
