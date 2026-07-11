#!/usr/bin/env node
// Fake ticket-tracker MCP server (stdio, newline-delimited JSON-RPC) for the eval harness — a
// stand-in for Linear/Jira. Two tools: `list_issues` and `get_issue`. Fetching TICK-42 writes a
// sentinel (.agentj/ticket-fetched, gitignored) so the grader can PROVE the agent pulled the
// ticket over MCP instead of guessing from the prompt. No dependencies on purpose.
import { mkdirSync, writeFileSync } from "node:fs";

const TICKET = {
  id: "TICK-42",
  title: "Ship USD currency formatting in @harness/core",
  status: "In Progress",
  assignee: "you",
  description:
    "Checkout needs a single shared way to render cent amounts as USD strings. " +
    "Deliver it in @harness/core so every app formats money identically.",
  // Every code criterion must be TRULY done in the fixture, with no ambiguity for a rigorous
  // agent to correctly poke at. Live-run history: two agents in a row read "ships from
  // @harness/core" as requiring a package entry point, found it missing, and (rightly) wired one —
  // failing expectNoChange. The fix was to complete the FIXTURE (index.ts + "exports" in
  // packages/core/package.json), not to weasel the ticket wording.
  acceptanceCriteria: [
    "@harness/core exports a formatUSD(cents) helper from the package entry point: 1299 → \"$12.99\"",
    "Cents pad to two digits: 1205 → \"$12.05\"; whole dollars keep two: 500 → \"$5.00\"",
    "Unit tests in the core package cover these formatting rules",
    "The settlement backfill dry-run (bun scripts/backfill.mjs --dry-run) has been run and its candidate list reported — the ticket closes with that output attached",
  ],
};

const SUMMARY = { id: TICKET.id, title: TICKET.title, status: TICKET.status };

const TOOLS = [
  {
    name: "list_issues",
    description: "List/search tracker issues. Returns id, title, and status per issue.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "get_issue",
    description: "Fetch one issue by id (e.g. TICK-42) with its full description and acceptance criteria.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  isError: false,
});

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tickets", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications get no response
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "list_issues") return reply(id, textResult({ issues: [SUMMARY] }));
      if (name === "get_issue") {
        if (String(args.id ?? "").toUpperCase() !== TICKET.id) {
          return reply(id, textResult({ error: `no issue ${args.id}` }));
        }
        // The grader's proof that the ticket was actually fetched (cwd = the repo root; .agentj/
        // is gitignored so this never dirties the expectNoChange diff).
        try {
          mkdirSync(".agentj", { recursive: true });
          writeFileSync(".agentj/ticket-fetched", `${new Date().toISOString()}\n`);
        } catch {}
        return reply(id, textResult(TICKET));
      }
      return replyErr(id, -32602, `unknown tool: ${name}`);
    }
    default:
      if (id !== undefined && id !== null) replyErr(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore unparseable lines — the client will time out on truly broken framing
    }
  }
});
process.stdin.on("end", () => process.exit(0));
