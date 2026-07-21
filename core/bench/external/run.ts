import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ArmId, benchmarkArms, benchmarkPrompt, pilotTaskIds, RUN_TIMEOUT_MS } from "./config";
import { estimateMatrixCost, loadModelsDevPrices } from "./pricing";
import {
  type NormalizedUsage,
  parseClaudeUsage,
  parseCodexUsage,
  parseOpenCodeUsage,
} from "./usage";

interface SweTask {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const benchRoot = resolve(flag("root") ?? "/tmp/agentj-external-bench");
const sourceRoot = new URL("../../", import.meta.url).pathname;

const exec = async (args: string[], cwd?: string): Promise<string> => {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}): ${stderr || stdout}`);
  return stdout;
};

const loadTasks = async (): Promise<SweTask[]> => {
  const wanted = new Set<string>(pilotTaskIds);
  const found = new Map<string, SweTask>();
  for (let offset = 0; offset < 500 && found.size < wanted.size; offset += 100) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.search = new URLSearchParams({
      dataset: "princeton-nlp/SWE-bench_Verified",
      config: "default",
      split: "test",
      offset: String(offset),
      length: "100",
    }).toString();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`SWE-bench dataset request failed: ${response.status}`);
    const payload = (await response.json()) as { rows: Array<{ row: SweTask }> };
    for (const { row } of payload.rows)
      if (wanted.has(row.instance_id)) found.set(row.instance_id, row);
  }
  const tasks = pilotTaskIds
    .map((id) => found.get(id))
    .filter((task): task is SweTask => Boolean(task));
  if (tasks.length !== pilotTaskIds.length)
    throw new Error("Not all pinned SWE-bench tasks were found.");
  return tasks;
};

const prepareWorkspace = async (task: SweTask, arm: ArmId): Promise<string> => {
  const source = join(benchRoot, "sources", task.repo.replace("/", "--"));
  const workspace = join(benchRoot, "workspaces", task.instance_id, arm);
  if (!(await Bun.file(join(source, ".git", "HEAD")).exists())) {
    await mkdir(join(benchRoot, "sources"), { recursive: true });
    await exec([
      "git",
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      `https://github.com/${task.repo}.git`,
      source,
    ]);
  }
  await exec(["git", "fetch", "origin", task.base_commit], source);
  await rm(workspace, { recursive: true, force: true });
  await exec(["git", "worktree", "prune"], source);
  await mkdir(join(benchRoot, "workspaces", task.instance_id), { recursive: true });
  await exec(["git", "worktree", "add", "--detach", workspace, task.base_commit], source);
  return workspace;
};

const commandFor = (arm: ArmId, workspace: string, prompt: string): string[] => {
  switch (arm) {
    case "agentj-luna":
      return ["bun", join(sourceRoot, "agent-loop.ts"), "run", "--allow-all", prompt];
    case "codex-sol":
      return [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "--cd",
        workspace,
        "--model",
        "gpt-5.6-sol",
        prompt,
      ];
    case "claude-opus-4.7":
    case "claude-fable-5":
      return [
        "claude",
        "--print",
        "--safe-mode",
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--max-budget-usd",
        "3",
        "--model",
        arm === "claude-opus-4.7" ? "claude-opus-4-7" : "claude-fable-5",
        prompt,
      ];
    case "opencode-luna":
      return [
        "opencode",
        "run",
        "--pure",
        "--auto",
        "--format",
        "json",
        "--model",
        "azure/gpt-5.6-luna",
        "--dir",
        workspace,
        prompt,
      ];
  }
};

const parseAgentjUsage = async (stateRoot: string): Promise<NormalizedUsage> => {
  const glob = new Bun.Glob("**/*.jsonl");
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  for await (const path of glob.scan({ cwd: stateRoot, absolute: true })) {
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      try {
        const row = JSON.parse(line) as {
          type?: string;
          usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
        };
        if (row.type === "usage") {
          inputTokens += row.usage?.inputTokens ?? 0;
          outputTokens += row.usage?.outputTokens ?? 0;
          cacheReadTokens += row.usage?.cacheReadInputTokens ?? 0;
        }
      } catch {}
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, reportedUsd: null };
};

const runAgent = async (task: SweTask, arm: ArmId) => {
  const workspace = await prepareWorkspace(task, arm);
  const runDir = join(benchRoot, "runs", task.instance_id, arm);
  const stateRoot = join(runDir, "state");
  await rm(runDir, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
  const started = Date.now();
  let timedOut = false;
  const child = Bun.spawn(commandFor(arm, workspace, benchmarkPrompt(task.problem_statement)), {
    cwd: workspace,
    env: { ...process.env, XDG_STATE_HOME: stateRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, RUN_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  await exec(["git", "add", "--intent-to-add", "--all"], workspace);
  const patch = await exec(["git", "diff", "--binary"], workspace);
  const usage =
    arm === "agentj-luna"
      ? await parseAgentjUsage(stateRoot)
      : arm === "codex-sol"
        ? parseCodexUsage(stdout)
        : arm.startsWith("claude-")
          ? parseClaudeUsage(stdout)
          : parseOpenCodeUsage(stdout);
  await Bun.write(join(runDir, "stdout.log"), stdout);
  await Bun.write(join(runDir, "stderr.log"), stderr);
  await Bun.write(join(runDir, "patch.diff"), patch);
  return {
    instanceId: task.instance_id,
    repo: task.repo,
    baseCommit: task.base_commit,
    arm,
    model: benchmarkArms.find(({ id }) => id === arm)?.model,
    exitCode,
    timedOut,
    wallMs: Date.now() - started,
    patchBytes: Buffer.byteLength(patch),
    usage,
    patch,
  };
};

const main = async () => {
  const tasks = await loadTasks();
  const selectedArms = benchmarkArms
    .map(({ id }) => id)
    .filter((id) => !flag("arm") || flag("arm")?.split(",").includes(id));
  const selectedTasks = tasks.filter(
    ({ instance_id }) => !flag("task") || flag("task")?.split(",").includes(instance_id),
  );
  console.log(
    `Pilot: ${selectedTasks.length} tasks × ${selectedArms.length} arms = ${selectedTasks.length * selectedArms.length} runs`,
  );
  const prices = await loadModelsDevPrices();
  const estimate = estimateMatrixCost(prices, selectedTasks.length, {
    inputTokens: 23_029,
    outputTokens: 817,
    cacheReadTokens: 0,
    reportedUsd: null,
  });
  console.log(
    `models.dev nominal estimate: $${selectedArms.reduce((sum, arm) => sum + estimate.byArm[arm], 0).toFixed(2)} ` +
      `(23,029 input + 817 output tokens per run; native agent overhead may be higher)`,
  );
  if (!has("run")) {
    for (const task of selectedTasks)
      console.log(`${task.instance_id}\t${task.repo}\t${task.base_commit}`);
    for (const arm of selectedArms) console.log(`arm\t${arm}`);
    console.log("Pass --run to execute.");
    return;
  }
  const resultsPath = join(benchRoot, "results.jsonl");
  for (const task of selectedTasks) {
    for (const arm of selectedArms) {
      console.log(`running ${task.instance_id} / ${arm}`);
      const result = await runAgent(task, arm);
      await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
      console.log(
        `finished exit=${result.exitCode} patch=${result.patchBytes}B time=${(result.wallMs / 1000).toFixed(1)}s`,
      );
    }
  }
  console.log(`Results: ${resultsPath}`);
};

await main();
