import { env } from "./env";
import { ToolLoopAgent, stepCountIs } from "ai";
import { createAzure } from "@ai-sdk/azure";
import { createBashTool, type Sandbox as BashToolSandbox } from "bash-tool";
import { Sandbox } from "microsandbox";
import { createDefaultEditTools, createHashlineEditTools } from "./edit-tools";

// --- fixture: three bugs, one hiding on a line duplicated verbatim elsewhere ---

const CALC_PY = `"""Utility math helpers for the pricing pipeline."""


def mean(values):
    total = 0
    for v in values:
        total += v
    return total / len(values)


def rolling_sums(values, window):
    """Return the sum of each consecutive window."""
    sums = []
    for i in range(len(values) - window):
        sums.append(sum(values[i:i + window]))
    return sums


def apply_discount(price, rate):
    """Discounted price: rate 0.2 -> 20% off."""
    if rate < 0 or rate > 1:
        raise ValueError("rate out of range")
    return price * (1 - rate)


def apply_surcharge(price, rate):
    """Surcharged price: rate 0.2 -> 20% extra."""
    if rate < 0 or rate > 1:
        raise ValueError("rate out of range")
    return price * (1 - rate)


def clamp(x, lo, hi):
    if x < lo:
        return lo
    if x > hi:
        return lo
    return x
`;

const TESTS_PY = `import sys

import calc

failures = []


def check(name, got, want):
    ok = got == want or (
        isinstance(got, float) and isinstance(want, float) and abs(got - want) < 1e-9
    )
    if not ok:
        failures.append(f"FAIL {name}: got {got!r}, want {want!r}")


check("mean", calc.mean([1, 2, 3, 4]), 2.5)
check("rolling_sums", calc.rolling_sums([1, 2, 3, 4], 2), [3, 5, 7])
check("discount", calc.apply_discount(100, 0.2), 80.0)
check("surcharge", calc.apply_surcharge(100, 0.2), 120.0)
check("clamp_low", calc.clamp(-5, 0, 10), 0)
check("clamp_high", calc.clamp(15, 0, 10), 10)
check("clamp_mid", calc.clamp(5, 0, 10), 5)

if failures:
    print("\\n".join(failures))
    sys.exit(1)
print("ALL TESTS PASSED")
`;

const PROMPT =
  "The directory /workspace contains calc.py and tests.py. Run `python3 tests.py` to see what fails, " +
  "then fix the bugs in calc.py so all tests pass, and re-run the tests to confirm. " +
  "Rules: modify calc.py only via the edit tool — never rewrite the whole file and never write to it " +
  "with shell redirection or heredocs. Do not modify tests.py.";

const INSTRUCTIONS =
  "You are an autonomous coding agent in a Linux sandbox. Complete the task with the available tools, then reply with a one-paragraph summary.";

// --- harness ---

const azure = createAzure({
  resourceName: "kayn-default-foundry-resource",
  apiKey: env.AZURE_FOUNDRY_API_KEY,
});
const model = azure("gpt-5.6-sol");

await using sb = await Sandbox.builder("abedit").image("python").replace().create();

const bashToolSandbox: BashToolSandbox = {
  async executeCommand(command) {
    const r = await sb.shell(command);
    return { stdout: r.stdout(), stderr: r.stderr(), exitCode: r.code };
  },
  async readFile(path) {
    return sb.fs().readToString(path);
  },
  async writeFiles(files) {
    for (const file of files) {
      const dir = file.path.split("/").slice(0, -1).join("/");
      if (dir) await sb.shell(`mkdir -p '${dir.replaceAll("'", "'\\''")}'`);
      await sb.fs().write(file.path, file.content);
    }
  },
};

const { bash } = await createBashTool({
  sandbox: bashToolSandbox,
  destination: "/workspace",
});

const variants = {
  default: () => createDefaultEditTools(sb),
  hashline: () => createHashlineEditTools(sb),
} as const;
type VariantName = keyof typeof variants;

interface RunResult {
  variant: VariantName;
  rep: number;
  pass: boolean;
  cheated: boolean;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  steps: number;
  editCalls: number;
  editErrors: number;
  readCalls: number;
  bashCalls: number;
  finalText: string;
}

async function resetWorkspace() {
  await sb.shell("rm -rf /workspace && mkdir -p /workspace");
  await sb.fs().write("/workspace/calc.py", CALC_PY);
  await sb.fs().write("/workspace/tests.py", TESTS_PY);
}

async function grade(): Promise<boolean> {
  // restore tests.py first so editing it can't game the grade
  await sb.fs().write("/workspace/tests.py", TESTS_PY);
  const r = await sb.shell("cd /workspace && python3 tests.py");
  return r.code === 0;
}

async function runOnce(variant: VariantName, rep: number): Promise<RunResult> {
  await resetWorkspace();
  const { readFile, edit } = variants[variant]();
  const agent = new ToolLoopAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: { bash, readFile, edit },
    stopWhen: stepCountIs(25),
  });

  const started = Date.now();
  const result = await agent.generate({ prompt: PROMPT });
  const wallMs = Date.now() - started;

  let editCalls = 0;
  let editErrors = 0;
  let readCalls = 0;
  let bashCalls = 0;
  let cheated = false;
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      if (call.toolName === "edit") editCalls++;
      else if (call.toolName === "readFile") readCalls++;
      else if (call.toolName === "bash") {
        bashCalls++;
        const cmd = String((call.input as { command?: string }).command ?? "");
        if (/(>>?|\btee\b)\s*(['"]?)(\/workspace\/)?calc\.py\2/.test(cmd)) cheated = true;
      }
    }
    for (const tr of step.toolResults) {
      const out = (tr as { output?: unknown }).output;
      if (tr.toolName === "edit" && typeof out === "string" && out.startsWith("ERROR")) {
        editErrors++;
      }
    }
  }

  const usage = (result as { totalUsage?: typeof result.usage }).totalUsage ?? result.usage;
  return {
    variant,
    rep,
    pass: await grade(),
    cheated,
    wallMs,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    steps: result.steps.length,
    editCalls,
    editErrors,
    readCalls,
    bashCalls,
    finalText: result.text.slice(0, 300),
  };
}

const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1] || "") || 3;
const only = process.argv.includes("--variant")
  ? [process.argv[process.argv.indexOf("--variant") + 1] as VariantName]
  : (Object.keys(variants) as VariantName[]);

const results: RunResult[] = [];
for (let rep = 1; rep <= repeat; rep++) {
  for (const variant of only) {
    console.error(`--- run ${variant} #${rep} ---`);
    try {
      const r = await runOnce(variant, rep);
      results.push(r);
      console.error(
        `    ${r.pass ? "PASS" : "FAIL"}${r.cheated ? " (cheated)" : ""} ` +
          `${(r.wallMs / 1000).toFixed(1)}s tokens=${r.totalTokens} steps=${r.steps} ` +
          `edits=${r.editCalls} editErrors=${r.editErrors}`,
      );
    } catch (e) {
      console.error(`    CRASH: ${e instanceof Error ? e.message : e}`);
      results.push({
        variant, rep, pass: false, cheated: false, wallMs: 0,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0,
        editCalls: 0, editErrors: 0, readCalls: 0, bashCalls: 0,
        finalText: `CRASH: ${e instanceof Error ? e.message : e}`,
      });
    }
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const summary = only.map((variant) => {
  const rs = results.filter((r) => r.variant === variant);
  return {
    variant,
    runs: rs.length,
    passes: rs.filter((r) => r.pass).length,
    cheats: rs.filter((r) => r.cheated).length,
    avgWallSecs: +(avg(rs.map((r) => r.wallMs)) / 1000).toFixed(1),
    avgTotalTokens: Math.round(avg(rs.map((r) => r.totalTokens))),
    avgInputTokens: Math.round(avg(rs.map((r) => r.inputTokens))),
    avgOutputTokens: Math.round(avg(rs.map((r) => r.outputTokens))),
    avgSteps: +avg(rs.map((r) => r.steps)).toFixed(1),
    avgEditCalls: +avg(rs.map((r) => r.editCalls)).toFixed(1),
    totalEditErrors: rs.reduce((a, r) => a + r.editErrors, 0),
  };
});

console.log(JSON.stringify({ summary, results }, null, 2));
await Bun.write("core/ab-edit-results.json", JSON.stringify({ summary, results }, null, 2));
console.error("\nsummary:");
console.error(JSON.stringify(summary, null, 2));
