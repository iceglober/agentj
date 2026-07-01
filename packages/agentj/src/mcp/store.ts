// MCP auth store — OAuth secrets persisted at ~/.agentj/auth.json, keyed by server name. This holds
// access/refresh tokens and the dynamic-client-registration result, so it's written 0600 (and the
// directory 0700). Read-merge-write per server.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Auth file location. `AGENTJ_AUTH_FILE` overrides it (CI / tests / non-standard homes). */
const authPath = (): string => process.env.AGENTJ_AUTH_FILE || join(homedir(), ".agentj", "auth.json");

/** Per-server OAuth state. All optional — a server may have only a DCR registration, or only tokens. */
export interface ServerAuth {
  /** Dynamic-client-registration result (client_id/secret the server issued us). */
  clientInformation?: OAuthClientInformationFull;
  /** Access + refresh tokens. */
  tokens?: OAuthTokens;
  /** PKCE code verifier, held between the authorize redirect and the token exchange. */
  codeVerifier?: string;
  /** Wall-clock ms when tokens were last saved — for `agentj mcp list` display. */
  obtainedAt?: number;
}

type AuthFile = Record<string, ServerAuth>;

async function readAll(): Promise<AuthFile> {
  try {
    const parsed = JSON.parse(await readFile(authPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as AuthFile) : {};
  } catch {
    return {}; // missing / unreadable → no auth yet
  }
}

async function writeAll(data: AuthFile): Promise<void> {
  await mkdir(dirname(authPath()), { recursive: true, mode: 0o700 });
  await writeFile(authPath(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** Current auth for one server (empty object if none). */
export async function readServerAuth(server: string): Promise<ServerAuth> {
  return (await readAll())[server] ?? {};
}

/** Merge `patch` into one server's auth, preserving its other fields. */
export async function writeServerAuth(server: string, patch: Partial<ServerAuth>): Promise<void> {
  const all = await readAll();
  all[server] = { ...all[server], ...patch };
  await writeAll(all);
}

/** Forget one server's auth entirely (`agentj mcp logout`). */
export async function clearServerAuth(server: string): Promise<void> {
  const all = await readAll();
  if (!(server in all)) return;
  delete all[server];
  await writeAll(all);
}

/** Names of every server with stored auth — for `agentj mcp list`. */
export async function listServerAuth(): Promise<Array<{ server: string; auth: ServerAuth }>> {
  const all = await readAll();
  return Object.entries(all).map(([server, auth]) => ({ server, auth }));
}
