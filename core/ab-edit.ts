import { env } from "./env";
import { ToolLoopAgent, stepCountIs } from "ai";
import { createAzure } from "@ai-sdk/azure";
import { createBashTool, type Sandbox as BashToolSandbox } from "bash-tool";
import { Sandbox } from "microsandbox";
import {
  createBatchedEditTools,
  createDefaultEditTools,
  createHashlineEditTools,
} from "./tools/edit";

// --- fixture: 4-file package, 8 bugs. `return price * (1 - rate)` appears
// verbatim in three functions (one correct, two buggy) as a string-matching
// trap; a cross-file rename (fmt_money vs format_money) spans utils/cart. ---

const UTILS_PY = `"""Shared helpers."""

import re
from decimal import Decimal, ROUND_HALF_UP

SKU_RE = re.compile(r"^[A-Z]{3}-\\d{4}$")


def validate_sku(sku):
    if not SKU_RE.match(sku):
        raise ValueError(f"bad sku: {sku}")
    return sku


def round_money(value):
    """Round to cents, half away from zero."""
    return round(value, 2)


def fmt_money(value):
    return f"\${round_money(value):.2f}"
`;

const MODELS_PY = `"""Catalog and inventory."""

from utils import validate_sku


class Item:
    def __init__(self, sku, name, price):
        self.sku = validate_sku(sku)
        self.name = name
        self.price = price

    def __repr__(self):
        return f"Item({self.sku!r}, {self.name!r}, {self.price!r})"


class Inventory:
    def __init__(self, stock=None):
        self.stock = dict(stock or {})

    def restock(self, sku, qty):
        self.stock[sku] = self.stock.get(sku, 0) + qty

    def available(self, sku):
        return self.stock.get(sku, 0)

    def reserve(self, sku, qty):
        """Reserve qty units; return True on success."""
        if self.stock.get(sku, 0) > qty:
            self.stock[sku] -= qty
            return True
        return False
`;

const PRICING_PY = `"""Price adjustment helpers."""

import utils


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


def apply_tax(price, rate):
    """Price with sales tax applied."""
    if rate < 0 or rate > 1:
        raise ValueError("rate out of range")
    return price * (1 - rate)


def bulk_discount_rate(qty):
    if qty >= 50:
        return 0.15
    if qty >= 20:
        return 0.10
    if qty > 10:
        return 0.05
    return 0.0


def line_total(item, qty):
    rate = bulk_discount_rate(qty)
    return utils.round_money(item.price * qty * (1 - rate))
`;

const CART_PY = `"""Shopping cart built on pricing and inventory."""

import pricing
import utils


class Cart:
    def __init__(self, inventory):
        self.inventory = inventory
        self.lines = []

    def add(self, item, qty):
        if qty < 0:
            raise ValueError("qty must be positive")
        if not self.inventory.reserve(item.sku, qty):
            raise ValueError(f"insufficient stock for {item.sku}")
        self.lines.append((item, qty))

    def total(self):
        subtotal = 0.0
        for item, qty in self.lines[:-1]:
            subtotal += pricing.line_total(item, qty)
        return utils.round_money(subtotal)

    def receipt(self):
        parts = [f"{item.name} x{qty}" for item, qty in self.lines]
        parts.append(utils.format_money(self.total()))
        return "\\n".join(parts)
`;

const TESTS_PY = `import sys

import cart as cart_mod
import pricing
import utils
from models import Inventory, Item

failures = []


def run(name, fn, want):
    try:
        got = fn()
    except Exception as e:
        failures.append(f"FAIL {name}: raised {type(e).__name__}: {e}")
        return
    ok = got == want or (
        isinstance(got, float) and isinstance(want, float) and abs(got - want) < 1e-9
    )
    if not ok:
        failures.append(f"FAIL {name}: got {got!r}, want {want!r}")


def raises(name, fn, exc):
    try:
        fn()
    except exc:
        return
    except Exception as e:
        failures.append(f"FAIL {name}: raised {type(e).__name__}, want {exc.__name__}")
        return
    failures.append(f"FAIL {name}: no exception, want {exc.__name__}")


run("round_money_half_up", lambda: utils.round_money(2.675), 2.68)
run("round_money_down", lambda: utils.round_money(2.664), 2.66)
run("discount", lambda: pricing.apply_discount(100, 0.2), 80.0)
run("surcharge", lambda: pricing.apply_surcharge(100, 0.2), 120.0)
run("tax", lambda: pricing.apply_tax(100, 0.08), 108.0)
run("bulk_rate_none", lambda: pricing.bulk_discount_rate(5), 0.0)
run("bulk_rate_10", lambda: pricing.bulk_discount_rate(10), 0.05)
run("bulk_rate_20", lambda: pricing.bulk_discount_rate(20), 0.10)
run("bulk_rate_50", lambda: pricing.bulk_discount_rate(50), 0.15)

widget = Item("AAA-0001", "widget", 2.50)
gadget = Item("BBB-0002", "gadget", 10.00)
gizmo = Item("CCC-0003", "gizmo", 0.99)

run("line_total_bulk", lambda: pricing.line_total(widget, 10), 23.75)


def reserve_exact():
    inv = Inventory({"AAA-0001": 5})
    ok = inv.reserve("AAA-0001", 5)
    return (ok, inv.available("AAA-0001"))


run("reserve_exact", reserve_exact, (True, 0))


def reserve_too_many():
    inv = Inventory({"AAA-0001": 5})
    return inv.reserve("AAA-0001", 6)


run("reserve_too_many", reserve_too_many, False)


def make_cart():
    inv = Inventory({"AAA-0001": 10, "BBB-0002": 10, "CCC-0003": 10})
    c = cart_mod.Cart(inv)
    c.add(widget, 2)
    c.add(gadget, 1)
    c.add(gizmo, 3)
    return c


raises("add_zero_qty", lambda: make_cart().add(widget, 0), ValueError)
run("cart_total", lambda: make_cart().total(), 17.97)
run("receipt", lambda: "$17.97" in make_cart().receipt(), True)

if failures:
    print("\\n".join(failures))
    sys.exit(1)
print("ALL TESTS PASSED")
`;

const FILES: Record<string, string> = {
  "utils.py": UTILS_PY,
  "models.py": MODELS_PY,
  "pricing.py": PRICING_PY,
  "cart.py": CART_PY,
  "tests.py": TESTS_PY,
};

// known-good patches, used only by --selfcheck to validate the fixture
const FIXED: Record<string, string> = {
  "utils.py": UTILS_PY.replace(
    "    return round(value, 2)",
    '    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))',
  ),
  "models.py": MODELS_PY.replace(
    "if self.stock.get(sku, 0) > qty:",
    "if self.stock.get(sku, 0) >= qty:",
  ),
  "pricing.py": PRICING_PY.replace(
    '"""Surcharged price: rate 0.2 -> 20% extra."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 - rate)',
    '"""Surcharged price: rate 0.2 -> 20% extra."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 + rate)',
  )
    .replace(
      '"""Price with sales tax applied."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 - rate)',
      '"""Price with sales tax applied."""\n    if rate < 0 or rate > 1:\n        raise ValueError("rate out of range")\n    return price * (1 + rate)',
    )
    .replace("if qty > 10:", "if qty >= 10:"),
  "cart.py": CART_PY.replace("if qty < 0:", "if qty <= 0:")
    .replace("for item, qty in self.lines[:-1]:", "for item, qty in self.lines:")
    .replace("utils.format_money(", "utils.fmt_money("),
  "tests.py": TESTS_PY,
};

const PROMPT =
  "The directory /workspace contains a small Python package (models.py, pricing.py, cart.py, utils.py) " +
  "and its test suite tests.py. Run `python3 tests.py` to see what fails, then fix the bugs in the " +
  "source files so all tests pass, and re-run the tests to confirm. " +
  "Rules: modify source files only via the edit tool — never rewrite whole files and never write to them " +
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
  batched: () => createBatchedEditTools(sb),
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

async function writeFixture(files: Record<string, string>) {
  await sb.shell("rm -rf /workspace && mkdir -p /workspace");
  for (const [name, content] of Object.entries(files)) {
    await sb.fs().write(`/workspace/${name}`, content);
  }
}

async function runTests() {
  return sb.shell("cd /workspace && python3 tests.py");
}

async function grade(): Promise<boolean> {
  // restore tests.py first so editing it can't game the grade
  await sb.fs().write("/workspace/tests.py", TESTS_PY);
  return (await runTests()).code === 0;
}

async function selfcheck() {
  await writeFixture(FILES);
  const buggy = await runTests();
  if (buggy.code === 0) throw new Error("selfcheck: buggy fixture unexpectedly passes");
  const failLines = buggy.stdout().trim().split("\n").filter((l) => l.startsWith("FAIL"));
  console.error(`selfcheck: buggy fixture fails ${failLines.length} checks:`);
  for (const l of failLines) console.error(`  ${l}`);
  await writeFixture(FIXED);
  const fixed = await runTests();
  if (fixed.code !== 0)
    throw new Error(`selfcheck: fixed fixture fails:\n${fixed.stdout()}${fixed.stderr()}`);
  console.error("selfcheck: fixed fixture passes. Fixture is consistent.");
}

async function runOnce(variant: VariantName, rep: number): Promise<RunResult> {
  await writeFixture(FILES);
  const { readFile, edit } = variants[variant]();
  const agent = new ToolLoopAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: { bash, readFile, edit },
    stopWhen: stepCountIs(30),
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
        if (/(>>?|\btee\b)\s*(['"]?)[^\s'"]*\.py\2/.test(cmd)) cheated = true;
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

if (process.argv.includes("--selfcheck")) {
  await selfcheck();
  process.exit(0);
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
        `    ${variant} ${r.pass ? "PASS" : "FAIL"}${r.cheated ? " (cheated)" : ""} ` +
          `${(r.wallMs / 1000).toFixed(1)}s tokens=${r.totalTokens} steps=${r.steps} ` +
          `edits=${r.editCalls} editErrors=${r.editErrors}`,
      );
    } catch (e) {
      console.error(`    ${variant} CRASH: ${e instanceof Error ? e.message : e}`);
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
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const summary = only.map((variant) => {
  const rs = results.filter((r) => r.variant === variant);
  return {
    variant,
    runs: rs.length,
    passes: rs.filter((r) => r.pass).length,
    cheats: rs.filter((r) => r.cheated).length,
    medianWallSecs: +(median(rs.map((r) => r.wallMs)) / 1000).toFixed(1),
    avgTotalTokens: Math.round(avg(rs.map((r) => r.totalTokens))),
    avgInputTokens: Math.round(avg(rs.map((r) => r.inputTokens))),
    avgOutputTokens: Math.round(avg(rs.map((r) => r.outputTokens))),
    avgSteps: +avg(rs.map((r) => r.steps)).toFixed(1),
    avgEditCalls: +avg(rs.map((r) => r.editCalls)).toFixed(1),
    totalEditErrors: rs.reduce((a, r) => a + r.editErrors, 0),
  };
});

console.log(JSON.stringify({ summary, results }, null, 2));
await Bun.write("core/ab-edit-results-v2.json", JSON.stringify({ summary, results }, null, 2));
console.error("\nsummary:");
console.error(JSON.stringify(summary, null, 2));
