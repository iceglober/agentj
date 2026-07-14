import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../lib/config";
import {
  configHash,
  type EvalConfig,
  type ResultRow,
  type RunConfig,
  resultRowSchema,
  runConfigSchema,
  usdCost,
} from "../lib/eval/config";
import { composeGrade } from "../lib/eval/grade";
import { type GradeCtx, type Task, type Trajectory, taskKey } from "../lib/eval/types";
import { createRuntime, type LlmConfig } from "../lib/llm";
import { getSandbox } from "../lib/sandbox";
import { createSandboxProviderLocal } from "../lib/sandbox/local-adapter";
import { createSandboxProviderMicrosandbox } from "../lib/sandbox/microsandbox-adapter";
import { createInProcessAdapter } from "./adapters/in-process";
import { createSandboxFixtureFactory } from "./adapters/sandbox-env";

// Resolve paths against the repo root (two levels up from core/eval/run.ts) so
// the harness works regardless of the cwd it is invoked from.
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const CONFIG_PATH = new URL("../agentj.json", import.meta.url).pathname;

// --- argv (house style: no CLI dep) --------------------------------------
const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const csv = (name: string): string[] | undefined =>
  flag(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const noJudge: GradeCtx = { judge: async () => null };

async function loadRunConfigs(configsDir: string, only?: string[]): Promise<RunConfig[]> {
  const out: RunConfig[] = [];
  for await (const file of new Bun.Glob("*.json").scan({ cwd: configsDir, absolute: true })) {
    out.push(runConfigSchema.parse(await Bun.file(file).json()));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return only ? out.filter((c) => only.includes(c.id)) : out;
}

async function loadTasks(tasksDir: string, split: string, only?: string[]): Promise<Task[]> {
  const dir = join(tasksDir, split);
  const tasks: Task[] = [];
  for await (const file of new Bun.Glob("*.ts").scan({ cwd: dir, absolute: true })) {
    const mod = (await import(file)) as { default: Task | Task[] };
    const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
    tasks.push(...exported);
  }
  tasks.sort((a, b) => taskKey(a).localeCompare(taskKey(b)));
  return only ? tasks.filter((t) => only.some((s) => taskKey(t).includes(s))) : tasks;
}

/** A serial worker pool over `items`, at most `n` in flight. */
async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (idx < items.length) await worker(items[idx++]!);
  });
  await Promise.all(lanes);
}

/** reference.files → the writeFiles shape. */
const refFiles = (task: Task) =>
  Object.entries(task.reference?.files ?? {}).map(([path, content]) => ({ path, content }));

function buildJudge(evalCfg: EvalConfig, baseLlm: LlmConfig): GradeCtx {
  if (!evalCfg.judge.enabled) return noJudge;
  // Reuse the agent's provider/auth, swap in the judge model.
  const runtime = createRuntime({ ...baseLlm, model: evalCfg.judge.model });
  return {
    judge: async (rubric, diff, report) => {
      try {
        const { text } = await runtime.generate({
          instructions:
            `You are grading a code change against a rubric. Respond ONLY with JSON ` +
            `{"pass": boolean, "reason": string}.`,
          prompt: `Rubric: ${rubric}\n\nDiff:\n${diff}\n\nAgent report:\n${report}`,
          tools: {},
          stopSteps: 1,
        });
        const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        return { pass: Boolean(parsed.pass), reason: String(parsed.reason ?? "") };
      } catch {
        return null;
      }
    },
  };
}

async function main() {
  const cfg = await loadConfig(CONFIG_PATH);
  const evalCfg = cfg.eval;
  const resolve = (d: string) => (d.startsWith("/") ? d : join(REPO_ROOT, d));

  const split = flag("split") ?? "dev";
  const seedCount = Number(flag("seeds") ?? evalCfg.defaultSeeds);
  const concurrency = Number(flag("concurrency") ?? evalCfg.concurrency);
  const runId = flag("run-id") ?? new Date().toISOString().replace(/[:.]/g, "-");

  const configs = await loadRunConfigs(resolve(evalCfg.configsDir), csv("config"));
  const tasks = await loadTasks(resolve(evalCfg.tasksDir), split, csv("task"));

  if (configs.length === 0) throw new Error("no run configs matched");
  if (tasks.length === 0) throw new Error(`no tasks matched in split "${split}"`);

  const seeds = Array.from({ length: seedCount }, (_, i) => i);
  const hashes = new Map(configs.map((c) => [c.id, configHash(c)] as const));

  // --- dry-run: print the matrix and exit ---------------------------------
  if (has("dry-run")) {
    const total = tasks.length * configs.length * seeds.length;
    console.log(
      `Trial matrix: ${configs.length} configs × ${tasks.length} tasks × ${seeds.length} seeds = ${total} trials\n`,
    );
    console.log("Configs:");
    for (const c of configs)
      console.log(`  ${c.id.padEnd(12)} ${hashes.get(c.id)}  ${c.agent.llm.model}`);
    console.log("\nTasks:");
    for (const t of tasks) console.log(`  ${taskKey(t).padEnd(28)} [${t.tags.join(", ")}]`);
    console.log("\nTrials:");
    for (const t of tasks)
      for (const c of configs)
        for (const s of seeds)
          console.log(
            `  ${taskKey(t).padEnd(28)} ${c.id.padEnd(12)}(${hashes.get(c.id)}) seed=${s}`,
          );
    return;
  }

  // --- selfcheck: solvable + falsifiable, no model ------------------------
  if (has("selfcheck")) {
    await using sandbox = await getSandbox(createSandboxProviderLocal());
    const factory = createSandboxFixtureFactory(sandbox, { root: join(sandbox.root, "eval") });

    const synthTraj = async (env: {
      diff(): Promise<string>;
      changedFiles(): Promise<string[]>;
    }): Promise<Trajectory> => ({
      toolCalls: [],
      toolResults: [],
      finalText: "",
      finalDiff: await env.diff(),
      filesTouched: await env.changedFiles(),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: 0,
      wallMs: 0,
    });

    let violations = 0;
    for (const task of tasks) {
      let solvable = false;
      let falsifiable = false;
      let detail = "";

      // (a) reference solution must PASS
      {
        const env = await factory.make(task.fixture);
        try {
          const files = refFiles(task);
          if (files.length > 0) await env.writeFiles(files);
          if (task.reference?.command) await env.exec(task.reference.command);
          const grade = await composeGrade(env, task, await synthTraj(env), noJudge);
          solvable = grade.verdict === "pass";
          if (!solvable) detail = `reference verdict=${grade.verdict}: ${gradeSummary(grade)}`;
        } finally {
          await env.destroy();
        }
      }
      // (b) a no-op must FAIL
      {
        const env = await factory.make(task.fixture);
        try {
          const grade = await composeGrade(env, task, await synthTraj(env), noJudge);
          falsifiable = grade.verdict === "fail";
          if (!falsifiable && !detail) detail = `no-op verdict=${grade.verdict} (expected fail)`;
        } finally {
          await env.destroy();
        }
      }

      const ok = solvable && falsifiable;
      if (!ok) violations++;
      console.log(`${ok ? "✓" : "✗"} ${taskKey(task)}${ok ? "" : `  — ${detail}`}`);
    }

    console.log(
      violations === 0
        ? `\nselfcheck OK: ${tasks.length} task(s) solvable and falsifiable`
        : `\nselfcheck FAILED: ${violations}/${tasks.length} task(s) violated`,
    );
    process.exit(violations === 0 ? 0 : 1);
  }

  // --- real runs ----------------------------------------------------------
  const resultsDir = resolve(evalCfg.resultsDir);
  const trajDir = join(resolve(evalCfg.trajDir), runId);
  await mkdir(resultsDir, { recursive: true });
  await mkdir(trajDir, { recursive: true });
  const resultsFile = join(resultsDir, `${runId}.jsonl`);

  await using sandbox = await getSandbox(
    createSandboxProviderMicrosandbox({ ...cfg.sandbox, name: "eval" }),
  );
  const factory = createSandboxFixtureFactory(sandbox, { root: "/workspace/eval" });
  const adapter = createInProcessAdapter(sandbox);
  const judgeCtx = buildJudge(evalCfg, cfg.agent.llm);

  // Serialize appends so concurrent trials never interleave a JSONL line.
  let writeChain: Promise<void> = Promise.resolve();
  const appendRow = (row: ResultRow) => {
    writeChain = writeChain.then(() => appendFile(resultsFile, `${JSON.stringify(row)}\n`));
    return writeChain;
  };

  interface Trial {
    task: Task;
    config: RunConfig;
    seed: number;
  }
  const trials: Trial[] = [];
  for (const task of tasks)
    for (const config of configs) for (const seed of seeds) trials.push({ task, config, seed });

  const rows: ResultRow[] = [];

  await pool(trials, concurrency, async ({ task, config, seed }) => {
    const env = await factory.make(task.fixture);
    try {
      const traj = await adapter.run(task, env, config);
      if (!traj.error && !traj.timedOut) {
        if (!traj.finalDiff) traj.finalDiff = await env.diff();
        if (traj.filesTouched.length === 0) traj.filesTouched = await env.changedFiles();
      }

      const fname = `${taskKey(task)}-${config.id}-s${seed}.json`;
      const trajRef = join(evalCfg.trajDir, runId, fname);
      await Bun.write(join(trajDir, fname), JSON.stringify(traj, null, 2));

      const grade = await composeGrade(env, task, traj, judgeCtx);
      const row = resultRowSchema.parse({
        runId,
        ts: new Date().toISOString(),
        configHash: hashes.get(config.id)!,
        configId: config.id,
        promptVersion: traj.promptVersion ?? "",
        task: taskKey(task),
        seed,
        verdict: grade.verdict,
        tokensIn: traj.usage.inputTokens,
        tokensOut: traj.usage.outputTokens,
        usd: usdCost(
          evalCfg.prices,
          config.agent.llm.model,
          traj.usage.inputTokens,
          traj.usage.outputTokens,
        ),
        secs: +(traj.wallMs / 1000).toFixed(1),
        filesTouched: traj.filesTouched.length,
        subscores: grade.subscores,
        fails: grade.checks.filter((c) => c.required && !c.skipped && !c.pass).map((c) => c.id),
        trajRef,
      });
      rows.push(row);
      await appendRow(row);
      console.log(
        `[${row.verdict.padEnd(7)}] ${row.task.padEnd(28)} ${config.id.padEnd(12)} s${seed} ` +
          `tok=${row.tokensIn}/${row.tokensOut} ${row.secs}s`,
      );
    } finally {
      await env.destroy();
    }
  });
  await writeChain;

  // --- summary ------------------------------------------------------------
  console.log(`\nSummary (run ${runId}) → ${resultsFile}`);
  for (const config of configs) {
    const rs = rows.filter((r) => r.configId === config.id);
    const count = (v: string) => rs.filter((r) => r.verdict === v).length;
    console.log(
      `  ${config.id.padEnd(12)} n=${rs.length}  pass=${count("pass")} fail=${count("fail")} ` +
        `error=${count("error")} timeout=${count("timeout")}`,
    );
  }
}

function gradeSummary(grade: Awaited<ReturnType<typeof composeGrade>>): string {
  return grade.checks
    .filter((c) => !c.pass)
    .map((c) => `${c.id}(${c.detail})`)
    .join("; ");
}

await main();
