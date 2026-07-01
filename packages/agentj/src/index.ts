#!/usr/bin/env bun
// agentj — CLI entry point.
//
//   agentj                          chat in the current repo
//   agentj --once "<task>"          run one task headlessly, then exit
//   agentj mcp list                 show configured MCP servers + auth status
//   agentj mcp login <name>         authorize a remote MCP server (OAuth, browser)
//   agentj mcp logout <name>        forget a server's stored tokens
//
// Flags: --provider <vertex|anthropic>, --model <id> (env AGENTJ_PROVIDER / AGENTJ_MODEL); -h, -v.
import type { ModelMessage } from "ai";
import { runTurn } from "./agent.ts";
import { chat } from "./chat.ts";
import { hasStaticAuth, loadMcpServers } from "./mcp/config.ts";
import { connectServers } from "./mcp/client.ts";
import { mcpToolSet } from "./mcp/adapter.ts";
import { loginToServer } from "./mcp/oauth.ts";
import { clearServerAuth, readServerAuth } from "./mcp/store.ts";
import { preflight, type Provider, resolveModel, resolveProvider } from "./model.ts";
import { systemPrompt } from "./system-prompt.ts";
import { createTurnRenderer } from "./render.ts";
import { makeTools } from "./tools.ts";
import { run } from "./exec.ts";
import { initTelemetry } from "./otel.ts";

const VERSION = "0.1.0";

const HELP = `agentj — a simple terminal coding agent

Usage:
  agentj                       chat in the current repo
  agentj --once "<task>"       run one task headlessly, then exit
  agentj mcp list              show configured MCP servers + auth status
  agentj mcp login <name>      authorize a remote MCP server (OAuth)
  agentj mcp logout <name>     forget a server's stored tokens

Options:
  --provider <name>   vertex | anthropic | azure | custom (env AGENTJ_PROVIDER; default vertex)
  --model <id>        model id (env AGENTJ_MODEL; required for azure/custom)
  --base-url <url>    endpoint for --provider custom (env AGENTJ_BASE_URL); e.g. a Bifrost gateway
  -h, --help          show this help
  -v, --version       show version

Providers:
  vertex      Gemini on Google Vertex AI. Needs GOOGLE_VERTEX_PROJECT (+ ADC login).
  anthropic   Claude direct. Needs ANTHROPIC_API_KEY.
  azure       Azure AI Foundry (OpenAI-compatible). Needs AZURE_BASE_URL + AZURE_API_KEY + --model
              (the deployment name); optional AZURE_API_VERSION.
  custom      Any OpenAI-compatible endpoint (gateway/local). Needs --base-url (or AGENTJ_BASE_URL)
              + --model; optional AGENTJ_API_KEY (sent as a Bearer token).
`;

/** The git repo root for `cwd`, or `cwd` itself when it isn't a git repo. */
async function repoRoot(cwd = process.cwd()): Promise<string> {
  try {
    const r = await run(["git", "rev-parse", "--show-toplevel"], { cwd });
    const top = r.stdout.trim();
    if (r.exitCode === 0 && top) return top;
  } catch {
    // git missing / not a repo — fall through
  }
  return cwd;
}

/** Pull `--flag value` pairs and `--once`/`-h`/`-v` out of argv; return them plus leftover positionals. */
function parseArgs(argv: string[]): { provider?: Provider; model?: string; baseUrl?: string; once?: string; help: boolean; version: boolean; rest: string[] } {
  let provider: Provider | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let once: string | undefined;
  let help = false;
  let version = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "--provider") provider = resolveProvider(argv[++i]);
    else if (a === "--model") model = argv[++i];
    else if (a === "--base-url") baseUrl = argv[++i];
    else if (a === "--once") once = argv[++i];
    else rest.push(a);
  }
  return { provider, model, baseUrl, once, help, version, rest };
}

/** `agentj mcp …` subcommands. Returns a process exit code. */
async function runMcp(argv: string[]): Promise<number> {
  const [sub, name] = argv;
  const root = await repoRoot();
  const servers = await loadMcpServers(root);

  if (sub === "list") {
    if (servers.length === 0) {
      process.stdout.write("No MCP servers configured (.mcp.json not found in this repo or ~/.agentj/).\n");
      return 0;
    }
    for (const s of servers) {
      let status = "";
      if (s.transport === "stdio") status = "stdio (self-managed auth)";
      else if (hasStaticAuth(s)) status = `${s.transport} (static header)`;
      else {
        const auth = await readServerAuth(s.name);
        status = auth.tokens ? `${s.transport} (authorized)` : `${s.transport} (needs login — run: agentj mcp login ${s.name})`;
      }
      process.stdout.write(`${s.name.padEnd(20)} ${status}\n`);
    }
    return 0;
  }

  if (sub === "login") {
    if (!name) return fail("usage: agentj mcp login <name>");
    const cfg = servers.find((s) => s.name === name);
    if (!cfg) return fail(`no MCP server named "${name}" in this repo's config`);
    if (cfg.transport === "stdio") return fail(`"${name}" is a stdio server — it manages its own auth, no login needed`);
    if (hasStaticAuth(cfg)) return fail(`"${name}" uses a static Authorization header — no OAuth login needed`);
    process.stdout.write(`Authorizing "${name}"… a browser window will open.\n`);
    try {
      await loginToServer(cfg.name, cfg.url);
      process.stdout.write(`✓ "${name}" authorized.\n`);
      return 0;
    } catch (err) {
      return fail(`login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (sub === "logout") {
    if (!name) return fail("usage: agentj mcp logout <name>");
    await clearServerAuth(name);
    process.stdout.write(`Forgot stored tokens for "${name}".\n`);
    return 0;
  }

  return fail("usage: agentj mcp <list|login|logout> [name]");
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

/** Connect MCP servers and build the toolset + startup notices. Never throws. */
async function setupMcp(root: string): Promise<{ tools: ReturnType<typeof mcpToolSet>; notices: string[]; close: () => Promise<void> }> {
  const servers = await loadMcpServers(root);
  if (servers.length === 0) return { tools: {}, notices: [], close: async () => {} };
  const connected = await connectServers(servers);
  const notices = [
    ...connected.warnings,
    ...connected.needsAuth.map((s) => `${s.name} needs auth — run: agentj mcp login ${s.name}`),
  ];
  return { tools: mcpToolSet(connected.connections), notices, close: connected.close };
}

export async function main(argv: string[]): Promise<void> {
  await initTelemetry();
  const { provider: provFlag, model: modelFlag, baseUrl, once, help, version, rest } = parseArgs(argv);

  if (help) {
    process.stdout.write(HELP);
    return;
  }
  if (version) {
    process.stdout.write(`agentj ${VERSION}\n`);
    return;
  }
  if (rest[0] === "mcp") {
    process.exitCode = await runMcp(rest.slice(1));
    return;
  }

  const provider = provFlag ?? resolveProvider();
  const selector = { provider, modelId: modelFlag, baseURL: baseUrl };
  const credError = preflight(provider, selector);
  if (credError) {
    process.exitCode = fail(credError);
    return;
  }
  const { model, modelId } = resolveModel(selector);
  // Supervisor model for auto-continue: a cheaper one via AGENTJ_STEER_MODEL, else the main model.
  const steerModel = process.env.AGENTJ_STEER_MODEL ? resolveModel({ ...selector, modelId: process.env.AGENTJ_STEER_MODEL }).model : model;
  const root = await repoRoot();
  const system = systemPrompt({ companyName: process.env.AGENTJ_COMPANY, getCwd: () => root });
  const mcp = await setupMcp(root);

  try {
    if (once !== undefined) {
      // Headless one-shot: run a single turn, print events, exit on the result.
      for (const n of mcp.notices) process.stderr.write(`! ${n}\n`);
      const renderer = createTurnRenderer();
      const tools = { ...makeTools({ root }), ...mcp.tools };
      const messages: ModelMessage[] = [{ role: "user", content: once }];
      const res = await runTurn({ model, modelId, provider, system, tools, messages, emit: renderer.event, steerModel });
      renderer.finish();
      if (!res.ok) process.exitCode = 1;
    } else {
      await chat({ root, model, modelId, provider, system, mcpTools: mcp.tools, notices: mcp.notices, steerModel });
    }
  } finally {
    await mcp.close();
  }
}

// Direct execution (`bun src/index.ts` / the bin shim).
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
