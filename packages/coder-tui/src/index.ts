// coder-tui — host-side client entry. `bin/coder` calls `main()`.
//
// v1 is headless: `coder --once "<task>"` runs one task in-process via coder-server's
// runner, rooted at the current git repo, streaming to the terminal. The chat TUI + /
// palette + shell pane are P2 (see docs/PLAN.md).
import { runOnce } from "coder-server";
import type { Tier } from "coder-core";

const VERSION = "0.0.0";

const HELP = `coder — a coding agent that computes over inferring.

USAGE
  coder --once "<task>"     run one task headless, in the current repo

OPTIONS
  --tier <cheap|fast|mid|deep>   model tier (default: mid; env CODER_TIER)
  --model <id>                   exact model id (overrides tier; env CODER_MODEL)
  -h, --help                     show this help
  -v, --version                  print version

Requires ANTHROPIC_API_KEY. v1 runs on the host with no sandbox — commands and edits
run automatically. The chat TUI + shell pane land in P2.`;

const TIERS = new Set<Tier>(["cheap", "fast", "mid", "deep"]);

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function repoRoot(): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd: ["git", "rev-parse", "--show-toplevel"], stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0 && out.trim()) return out.trim();
  } catch {
    // not a git repo / git missing — fall through
  }
  return process.cwd();
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(VERSION);
    return;
  }

  const onceIdx = argv.indexOf("--once");
  if (onceIdx !== -1) {
    const task = argv[onceIdx + 1];
    if (!task || task.startsWith("--")) {
      console.error('[coder] --once needs a task, e.g. coder --once "add a --json flag"');
      process.exitCode = 1;
      return;
    }

    const tierArg = flagValue(argv, "--tier") ?? process.env.CODER_TIER;
    const tier: Tier = tierArg && TIERS.has(tierArg as Tier) ? (tierArg as Tier) : "mid";
    const modelId = flagValue(argv, "--model") ?? process.env.CODER_MODEL;

    const root = await repoRoot();
    console.error(`[coder] v1 — host, no sandbox; auto-running in ${root}\n`);

    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    try {
      const res = await runOnce({ task, root, tier, modelId, signal: ac.signal });
      if (!res.ok && res.error) console.error(`\n[coder] ${res.error}`);
      process.exitCode = res.ok ? 0 : 1;
    } finally {
      process.off("SIGINT", onSig);
    }
    return;
  }

  console.log(HELP);
}
