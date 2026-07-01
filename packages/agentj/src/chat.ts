// The interactive chat loop (the TUI). A single linear session: read a line, run a turn, repeat.
// Built-in tools are rebuilt each turn so they carry that turn's abort signal (Ctrl-C kills running
// commands); MCP tools are connected once and reused. Ctrl-C during a turn aborts just the turn and
// returns to the prompt; Ctrl-C / Ctrl-D at the prompt exits. The terminal is always restored.
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { runTurn } from "./agent.ts";
import { SLASH_COMMANDS } from "./commands.ts";
import { createLineReader } from "./input.ts";
import { isLinkedWorktree, rekey } from "./rekey.ts";
import { createTurnRenderer } from "./render.ts";
import { makeTools } from "./tools.ts";

const dim = (s: string): string => `\x1b[90m${s}\x1b[39m`;

export interface ChatOptions {
  root: string;
  model: LanguageModel;
  modelId: string;
  provider?: string;
  system: string;
  /** MCP tools, connected once at startup. Merged with the per-turn built-ins. */
  mcpTools: ToolSet;
  /** One-line startup notices (MCP failures / needs-auth), printed before the first prompt. */
  notices: string[];
  /** Model for the auto-continue supervisor check (defaults to `model`). */
  steerModel?: LanguageModel;
}

export async function chat(opts: ChatOptions): Promise<void> {
  const reader = createLineReader({ commands: SLASH_COMMANDS });
  process.stdout.write(`${dim(`agentj · ${opts.modelId} · ${opts.root}`)}\n`);
  process.stdout.write(`${dim("Ctrl-C interrupts a turn · /task <pr|branch> starts a clean task · Ctrl-D or /exit quits")}\n`);
  for (const n of opts.notices) process.stdout.write(`${dim(`! ${n}`)}\n`);

  let messages: ModelMessage[] = [];
  for (;;) {
    const line = await reader.read("\n› ");
    if (line === null) break; // Ctrl-C / Ctrl-D / EOF at the prompt → exit
    const input = line.trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;

    // `/task <ref> [description]` — LRW re-key: wipe the worktree, fetch, and re-point it at a clean
    // base from origin (PR checkout / existing branch / new branch off origin/main), then start the
    // task with fresh context. Destructive, so it's gated to a linked worktree.
    let prompt = input;
    if (input === "/task" || input.startsWith("/task ")) {
      const rest = input.slice("/task".length).trim();
      const ref = rest.split(/\s+/)[0] ?? "";
      if (!ref) {
        process.stdout.write(`${dim("usage: /task <pr-number | branch-name> [task description]")}\n`);
        continue;
      }
      if (!(await isLinkedWorktree(opts.root)) && process.env.AGENTJ_ALLOW_PRIMARY !== "1") {
        process.stdout.write(`${dim("» /task does a destructive reset to origin and is meant for a dedicated worktree — this looks like the primary checkout. Run agentj in your worktree, or set AGENTJ_ALLOW_PRIMARY=1 to override.")}\n`);
        continue;
      }
      process.stdout.write(`${dim(`» re-keying worktree → ${ref}`)}\n`);
      const rk = await rekey(opts.root, ref);
      for (const s of rk.steps) process.stdout.write(`${dim(`  · ${s}`)}\n`);
      if (!rk.ok) {
        process.stdout.write(`${dim(`» re-key failed: ${rk.error}`)}\n`);
        continue;
      }
      process.stdout.write(`${dim(`» clean on ${rk.branch}, synced to origin`)}\n`);
      messages = []; // new task → fresh context
      const desc = rest.slice(ref.length).trim();
      if (!desc) continue; // re-keyed only; wait for the task prompt
      prompt = desc;
    }

    const turnMessages: ModelMessage[] = [...messages, { role: "user", content: prompt }];
    const renderer = createTurnRenderer();
    const ac = new AbortController();
    // Catch Ctrl-C (raw byte 0x03) while the turn runs — the line reader isn't reading, so we listen
    // ourselves and abort the turn. Removed as soon as the turn ends so the next read() owns stdin.
    const onKey = (d: Buffer | string) => {
      if ((typeof d === "string" ? d : d.toString("utf8")).includes("\x03")) ac.abort();
    };
    process.stdin.on("data", onKey);
    let res: Awaited<ReturnType<typeof runTurn>>;
    try {
      const tools = { ...makeTools({ root: opts.root, signal: ac.signal }), ...opts.mcpTools };
      res = await runTurn({ model: opts.model, modelId: opts.modelId, provider: opts.provider, system: opts.system, tools, messages: turnMessages, emit: renderer.event, signal: ac.signal, steerModel: opts.steerModel });
    } finally {
      process.stdin.off("data", onKey);
      renderer.finish();
    }
    if (res.ok) messages = res.messages;
    else if (res.aborted) process.stdout.write(`${dim("[interrupted]")}\n`); // user turn dropped; history unchanged
  }
  reader.close();
}
