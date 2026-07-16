import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../lib/config";
import { type ResultRow, resultRowSchema } from "../lib/eval/config";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const CONFIG_PATH = new URL("../agentj.json", import.meta.url).pathname;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function latestRunFile(resultsDir: string): Promise<string | null> {
  let best: { file: string; mtime: number } | null = null;
  for await (const file of new Bun.Glob("*.jsonl").scan({ cwd: resultsDir, absolute: true })) {
    const m = (await stat(file)).mtimeMs;
    if (!best || m > best.mtime) best = { file, mtime: m };
  }
  return best?.file ?? null;
}

async function readRows(file: string): Promise<ResultRow[]> {
  const text = await Bun.file(file).text();
  const rows: ResultRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = resultRowSchema.safeParse(JSON.parse(line));
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function perConfigTable(rows: ResultRow[]) {
  const configs = [...new Set(rows.map((r) => r.configId))].sort();
  console.log(
    `${"config".padEnd(12)} ${"tasks".padStart(5)} ${"passRate".padStart(9)} ` +
      `${"min".padStart(5)} ${"max".padStart(5)} ${"medSecs".padStart(8)} ${"meanTokIn".padStart(10)}`,
  );
  for (const cid of configs) {
    const cr = rows.filter((r) => r.configId === cid);
    const tasks = [...new Set(cr.map((r) => r.task))].sort();
    const taskRates: number[] = [];
    for (const t of tasks) {
      const tr = cr.filter((r) => r.task === t && r.verdict !== "error"); // errors excluded
      if (tr.length === 0) continue;
      taskRates.push(tr.filter((r) => r.verdict === "pass").length / tr.length);
    }
    const nonError = cr.filter((r) => r.verdict !== "error");
    console.log(
      `${cid.padEnd(12)} ${String(tasks.length).padStart(5)} ${pct(mean(taskRates)).padStart(9)} ` +
        `${pct(Math.min(...taskRates, 1)).padStart(5)} ${pct(Math.max(...taskRates, 0)).padStart(5)} ` +
        `${median(nonError.map((r) => r.secs))
          .toFixed(1)
          .padStart(8)} ` +
        `${Math.round(mean(cr.map((r) => r.tokensIn)))
          .toString()
          .padStart(10)}`,
    );
  }
}

/** Pass rate per tag per config — shows which difficulty class moves a metric. */
function perTagTable(rows: ResultRow[]) {
  const tags = [...new Set(rows.flatMap((r) => r.tags))].sort();
  if (tags.length === 0) return;
  const configs = [...new Set(rows.map((r) => r.configId))].sort();

  console.log(`\n${"tag".padEnd(22)} ${configs.map((c) => c.padStart(12)).join(" ")}`);
  for (const tag of tags) {
    const cells = configs.map((cid) => {
      const tr = rows.filter(
        (r) => r.configId === cid && r.tags.includes(tag) && r.verdict !== "error",
      );
      if (tr.length === 0) return "—".padStart(12);
      const rate = tr.filter((r) => r.verdict === "pass").length / tr.length;
      return `${pct(rate)} n=${tr.length}`.padStart(12);
    });
    console.log(`${tag.padEnd(22)} ${cells.join(" ")}`);
  }
}

function compare(rows: ResultRow[], a: string, b: string) {
  const key = (r: ResultRow) => `${r.task}#${r.seed}`;
  const byKey = new Map<string, { a?: ResultRow; b?: ResultRow }>();
  for (const r of rows) {
    if (r.configId !== a && r.configId !== b) continue;
    const e = byKey.get(key(r)) ?? {};
    if (r.configId === a) e.a = r;
    else e.b = r;
    byKey.set(key(r), e);
  }

  const aPassBFail: string[] = [];
  const aFailBPass: string[] = [];
  let excluded = 0;
  for (const [k, { a: ra, b: rb }] of byKey) {
    if (!ra || !rb) continue;
    if (ra.verdict === "error" || rb.verdict === "error") {
      excluded++;
      continue;
    }
    if (ra.verdict === "pass" && rb.verdict !== "pass") aPassBFail.push(k);
    if (ra.verdict !== "pass" && rb.verdict === "pass") aFailBPass.push(k);
  }

  console.log(
    `\nCompare ${a} → ${b} (joined on task#seed; ${excluded} pair(s) excluded for errors)`,
  );
  console.log(`  ${a}-pass → ${b}-fail: ${aPassBFail.length}`);
  for (const k of aPassBFail) console.log(`    ${k}`);
  console.log(`  ${a}-fail → ${b}-pass: ${aFailBPass.length}`);
  for (const k of aFailBPass) console.log(`    ${k}`);
}

async function main() {
  const cfg = await loadConfig(CONFIG_PATH);
  const resultsDir = cfg.eval.resultsDir.startsWith("/")
    ? cfg.eval.resultsDir
    : join(REPO_ROOT, cfg.eval.resultsDir);

  const runId = flag("run");
  const file = runId ? join(resultsDir, `${runId}.jsonl`) : await latestRunFile(resultsDir);
  if (!file) {
    console.error(`no result files in ${resultsDir}`);
    process.exit(1);
  }
  const rows = await readRows(file);
  console.log(`Report for ${file} (${rows.length} rows)\n`);

  perConfigTable(rows);
  perTagTable(rows);

  const compareArgs = flag("compare");
  if (compareArgs) {
    const i = argv.indexOf("--compare");
    const a = argv[i + 1];
    const b = argv[i + 2];
    if (a && b) compare(rows, a, b);
    else console.error("--compare needs two config ids: --compare A B");
  }
}

await main();
