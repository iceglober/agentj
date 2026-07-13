import { createAgent } from "./lib/agent";
import { loadConfig } from "./lib/config";
import type { PromptContext } from "./lib/prompt";
import { getSandbox } from "./lib/sandbox";
import { createSandboxProviderMicrosandbox } from "./lib/sandbox/microsandbox-adapter";
import { createChildSession, createSession } from "./lib/session";

const config = await loadConfig(
  new URL("./agentj.json", import.meta.url).pathname,
);

const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 2;

const safeChildIdSegment = (value: string): string => {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || "task";
};

const configuredSubagentConcurrency = DEFAULT_SUBAGENT_MAX_CONCURRENCY;

const childSessionIds = new Set<string>();
let childSessionCounter = 0;
const nextChildSessionId = (taskId: string): string => {
  const stem = safeChildIdSegment(taskId);
  while (true) {
    childSessionCounter += 1;
    const candidate = `subagent-${childSessionCounter.toString().padStart(4, "0")}-${stem}`;
    if (childSessionIds.has(candidate)) {
      continue;
    }
    childSessionIds.add(candidate);
    return candidate;
  }
};

await using sandbox = await getSandbox(
  createSandboxProviderMicrosandbox(config.sandbox),
);
await using session = await createSession(sandbox, config.session);
console.error(`[session ${session.id}] ${session.branch} from ${session.base}`);

// A porcelain status is one file per line; empty means a clean tree.
const summarizeStatus = (porcelain: string): string => {
  const n = porcelain.split("\n").filter(Boolean).length;
  return n === 0 ? "clean" : `${n} files changed`;
};

// Per-turn environment facts the prompt footer stamps in. os comes from the
// sandbox (not the host) since that's where the agent's tools actually run.
const ctx: PromptContext = {
  cwd: session.path,
  os: (await sandbox.executeCommand("uname -sr")).stdout.trim(),
  date: new Date().toISOString().slice(0, 10),
  gitBranch: session.branch,
  gitStatusSummary: summarizeStatus(await session.status()),
};

// Best-effort project rules: explicit config wins, else the repo's AGENTS.md,
// else nothing. Reading a missing file throws in the sandbox port, so guard it.
let agentsMd = "";
try {
  agentsMd = await sandbox.readFile(`${session.path}/AGENTS.md`);
} catch {}
const rules = config.agent.rules || agentsMd || "";

const { generate, composed } = await createAgent(
  sandbox,
  { ...config.agent, rules },
  {
    root: session.path,
    ctx,
    delegation: {
      parentRef: session.branch,
      maxConcurrency: configuredSubagentConcurrency,
      createChildSession: ({ id, parentRef }) =>
        createChildSession(sandbox, config.session, {
          id: nextChildSessionId(id),
          parentRef,
        }),
    },
  },
);
console.error(`[prompt] profile=${composed.profile} version=${composed.version}`);

const argv =
  (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const prompt =
  argv.slice(2).join(" ") ||
  "Print the OS and python version of the machine you are on.";

const result = await generate(prompt, {
  onStep: (step) => {
    for (const call of step.toolCalls) {
      console.error(
        `[tool] ${call.name} ${JSON.stringify(call.input).slice(0, 200)}`,
      );
    }
    for (const toolResult of step.toolResults) {
      if (toolResult.name !== "run_subagents") {
        continue;
      }
      console.error(
        `[tool-result] ${toolResult.name} ${JSON.stringify(toolResult.output).slice(0, 200)}`,
      );
    }
  },
});

console.log(result.text);

const sha = await session.commitAll(`agentj: ${prompt.slice(0, 72)}`);
console.error(
  sha
    ? `[session ${session.id}] committed ${sha} on ${session.branch}`
    : `[session ${session.id}] no changes`,
);
