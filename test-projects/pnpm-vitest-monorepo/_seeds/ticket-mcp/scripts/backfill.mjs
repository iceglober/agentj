#!/usr/bin/env bun
// Settlement backfill for TICK-42 (eval stand-in for the real thing). Dry-run enumerates the
// candidate settlement files it WOULD dispatch; --execute is refused here so the only gradeable
// path is the dry-run. Writes .agentj/backfill-ran (gitignored) so the harness can PROVE the
// agent ran it rather than pasting the command back to the user.
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const repoRoot = new URL("..", import.meta.url).pathname;

if (args.includes("--execute")) {
  console.error("refusing --execute outside a production shell; run with --dry-run");
  process.exit(2);
}
if (!args.includes("--dry-run")) {
  console.error("usage: bun scripts/backfill.mjs --dry-run [--since <iso>]");
  process.exit(2);
}

const CANDIDATES = [
  { id: "stl_9001", org: "org_acme", receivedAt: "2026-07-01T09:15:00Z" },
  { id: "stl_9002", org: "org_acme", receivedAt: "2026-07-03T18:40:00Z" },
  { id: "stl_9003", org: "org_globex", receivedAt: "2026-07-08T02:05:00Z" },
];

try {
  mkdirSync(`${repoRoot}.agentj`, { recursive: true });
  writeFileSync(`${repoRoot}.agentj/backfill-ran`, `${new Date().toISOString()}\n`);
} catch {}

console.log(`DRY RUN: 3 candidate settlement files would be backfilled`);
for (const c of CANDIDATES) {
  console.log(`  ${c.id}  ${c.org}  received ${c.receivedAt}`);
}
console.log("no workflows dispatched (dry run)");
