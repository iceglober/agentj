#!/usr/bin/env bun
// Aggregate results/history.jsonl into a per-task reliability table: pass-rate, and median/min/max of
// wall-clock and input tokens across runs. This is what makes a "works on gpt-5.4" claim defensible —
// n and spread, not a single anecdote.
//
//   bun test-projects/report.ts                 # every task, all recorded runs
//   bun test-projects/report.ts cloud           # only ids containing "cloud"
//   bun test-projects/report.ts --run <stamp>   # only one run batch
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Row {
  id: string;
  variant?: string;
  pass: boolean;
  secs: number;
  tokensIn?: number;
  run?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const runFilter = argv.includes("--run") ? argv[argv.indexOf("--run") + 1] : undefined;
const includeAll = argv.includes("--all"); // include rows that never reached the model
const idFilter = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--run" && a !== "--all");

// A row belongs in a reliability/token baseline only if it actually reached the model — i.e. it
// reported input tokens. Rows without them (old no-creds boot failures, dry/selftest runs, and
// pre-token-accounting runs) are dropped unless --all is given.
const engaged = (r: Row): boolean => (r.tokensIn ?? 0) > 0;

const path = join(HERE, "results", "history.jsonl");
let raw: string;
try {
  raw = await readFile(path, "utf8");
} catch {
  console.error(`no history at ${path} — run some evals first`);
  process.exit(1);
}

const allRows: Row[] = raw
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => (!idFilter || r.id.includes(idFilter)) && (!runFilter || r.run === runFilter));
const rows = includeAll ? allRows : allRows.filter(engaged);
const dropped = allRows.length - rows.length;

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));

// Group by id@variant.
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const key = r.variant ? `${r.id}@${r.variant}` : r.id;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
}

const keys = [...groups.keys()].sort();
console.log(
  `\n${"task".padEnd(26)} ${"n".padStart(3)}  ${"pass".padStart(6)}  ${"secs (med·min·max)".padStart(20)}  ${"tokensIn (med·min·max)".padStart(24)}`,
);
console.log("─".repeat(88));
let flaky = 0;
for (const key of keys) {
  const g = groups.get(key)!;
  const passes = g.filter((r) => r.pass).length;
  const rate = `${passes}/${g.length}`;
  const reliable = passes === g.length;
  if (!reliable) flaky++;
  const secs = g.map((r) => r.secs);
  const toks = g.map((r) => r.tokensIn ?? 0).filter((x) => x > 0);
  const secCell = `${median(secs)}·${Math.min(...secs)}·${Math.max(...secs)}`;
  const tokCell = toks.length ? `${k(median(toks))}·${k(Math.min(...toks))}·${k(Math.max(...toks))}` : "—";
  const mark = reliable ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${mark} ${key.padEnd(24)} ${String(g.length).padStart(3)}  ${rate.padStart(6)}  ${secCell.padStart(20)}  ${tokCell.padStart(24)}`);
}
console.log("─".repeat(88));
const note = dropped && !includeAll ? ` · ${dropped} non-model rows dropped (use --all to include)` : "";
console.log(`${keys.length} task-variants · ${rows.length} runs${flaky ? ` · \x1b[31m${flaky} not 100% reliable\x1b[0m` : " · all reliable"}${note}\n`);
