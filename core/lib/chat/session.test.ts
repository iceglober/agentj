import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent, GenerateOptions } from "../agent";
import type { RunResult } from "../llm";
import { createChatLog, loadChatLog } from "../session/log";
import type { ChatEvent } from "./events";
import { createChatSession } from "./session";

const result = (text: string, over: Partial<RunResult> = {}): RunResult => ({
  text,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  messages: [{ role: "assistant", content: text }],
  ...over,
});

function makeAgent(impl: (prompt: string, opts?: GenerateOptions) => Promise<RunResult>): Agent {
  return { composed: {} as Agent["composed"], generate: impl };
}

async function withLog<T>(
  run: (log: Awaited<ReturnType<typeof createChatLog>>, root: string) => Promise<T>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "agentj-chat-"));
  try {
    const log = await createChatLog({ root, projectRoot: "/repo/x", title: "test" });
    return await run(log, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("createChatSession", () => {
  test("runs turns per mode, persists turn+state, threads the continuation", async () => {
    await withLog(async (log, root) => {
      const calls: Array<{ prompt: string; mode: string; messages?: unknown[] }> = [];
      const events: ChatEvent[] = [];
      const agents = {
        plan: makeAgent(async (prompt, opts) => {
          calls.push({ prompt, mode: "plan", messages: opts?.messages });
          return result("plan answer", { messages: [{ turn: 1 }] });
        }),
        build: makeAgent(async (prompt, opts) => {
          calls.push({ prompt, mode: "build", messages: opts?.messages });
          return result("build answer", { messages: [{ turn: 1 }, { turn: 2 }] });
        }),
      };
      const session = createChatSession({
        agentFor: async (mode) => agents[mode],
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(session.mode).toBe("plan");
      await session.send("what does this repo do?");
      expect(calls[0]).toMatchObject({ mode: "plan", messages: [] });

      session.setMode(); // Tab: plan → build
      expect(session.mode).toBe("build");
      await session.send("now build it");
      // The build turn receives the plan turn's continuation.
      expect(calls[1]).toMatchObject({ mode: "build", messages: [{ turn: 1 }] });

      const loaded = await loadChatLog({ root, projectRoot: "/repo/x", id: log.id });
      expect(loaded?.turns.map((turn) => turn.mode)).toEqual(["plan", "build"]);
      expect(loaded?.state?.messages).toEqual([{ turn: 1 }, { turn: 2 }]);
      expect(events.filter((event) => event.type === "assistant")).toHaveLength(2);
      expect(events.filter((event) => event.type === "turn-finished")).toHaveLength(2);
      expect(events.at(-1)?.type).toBe("turn-finished");
    });
  });

  test("persists a transformed opaque continuation after the turn", async () => {
    await withLog(async (log, root) => {
      const original = [{ vendor: "full-history" }];
      const compacted = [{ vendor: "summary" }];
      const session = createChatSession({
        agentFor: async () => makeAgent(async () => result("done", { messages: original })),
        log,
        transformContinuation: async (messages, mode) => {
          expect(messages).toBe(original);
          expect(mode).toBe("plan");
          return compacted;
        },
      });

      await session.send("go");

      expect(session.snapshot().messages).toBe(compacted);
      const loaded = await loadChatLog({ root, projectRoot: "/repo/x", id: log.id });
      expect(loaded?.state?.messages).toEqual(compacted);
    });
  });

  test("turn-usage reflects only the foreground agent's own steps — subagent usage stays out", async () => {
    await withLog(async (log) => {
      const events: ChatEvent[] = [];
      // The session's turn-usage stream is fed exclusively by the foreground
      // agent's onStep callback; subagents report through their own wiring
      // (task-usage progress events), so a context soft limit keyed on
      // turn-usage measures only the conversation-growing context.
      const agent = makeAgent(async (_prompt, opts) => {
        opts?.onStep?.({
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 210_000, outputTokens: 40, totalTokens: 210_040 },
        });
        return result("done");
      });
      const session = createChatSession({
        agentFor: async () => agent,
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      await session.send("go");

      const usage = events.filter((event) => event.type === "turn-usage");
      expect(usage).toEqual([
        {
          type: "turn-usage",
          usage: { inputTokens: 210_000, outputTokens: 40, totalTokens: 210_040 },
        },
      ]);
    });
  });

  test("uses a transcript label without changing the model prompt or durable user text", async () => {
    await withLog(async (log, root) => {
      const prompts: string[] = [];
      const events: ChatEvent[] = [];
      const session = createChatSession({
        agentFor: async () =>
          makeAgent(async (prompt) => {
            prompts.push(prompt);
            return result("built");
          }),
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      await session.send("internal implementation prompt", { transcriptText: "Command: build" });

      expect(prompts).toEqual(["internal implementation prompt"]);
      expect(events.find((event) => event.type === "turn-started")).toEqual({
        type: "turn-started",
        mode: "plan",
        text: "internal implementation prompt",
        transcriptText: "Command: build",
      });
      const loaded = await loadChatLog({ root, projectRoot: "/repo/x", id: log.id });
      expect(loaded?.turns[0]).toMatchObject({
        user: "internal implementation prompt",
        transcriptText: "Command: build",
      });
    });
  });

  test("queues messages during a running turn and applies Tab at the next turn", async () => {
    await withLog(async (log) => {
      let release: (() => void) | undefined;
      const modes: string[] = [];
      const events: ChatEvent[] = [];
      const session = createChatSession({
        agentFor: async (mode) => {
          return makeAgent(async () => {
            modes.push(mode);
            if (mode === "plan") await new Promise<void>((r) => (release = r));
            return result(`${mode} done`);
          });
        },
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      const first = session.send("slow question");
      await new Promise((r) => setTimeout(r, 5));
      expect(session.busy).toBe(true);

      session.setMode("build"); // mid-turn: pending
      expect(session.mode).toBe("plan"); // running turn keeps its mode
      expect(session.pendingMode).toBe("build");

      const second = session.send("queued task", { transcriptText: "Command: build" });
      await new Promise((r) => setTimeout(r, 5));
      expect(events.find((event) => event.type === "turn-queued")).toEqual({
        type: "turn-queued",
        text: "queued task",
        transcriptText: "Command: build",
      });

      release?.();
      await Promise.all([first, second]);
      expect(modes).toEqual(["plan", "build"]); // queued turn ran in the new mode
      expect(
        events
          .filter((event) => event.type === "turn-started" || event.type === "turn-finished")
          .map((event) => event.type),
      ).toEqual(["turn-started", "turn-finished", "turn-started", "turn-finished"]);
    });
  });

  test("dequeue removes the newest queued message, resolves its send, and emits the event", async () => {
    await withLog(async (log) => {
      let release: (() => void) | undefined;
      const prompts: string[] = [];
      const events: ChatEvent[] = [];
      const session = createChatSession({
        agentFor: async () =>
          makeAgent(async (prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) await new Promise<void>((r) => (release = r));
            return result("ok");
          }),
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(session.dequeue()).toBeNull(); // idle: nothing queued

      const first = session.send("slow question");
      await new Promise((r) => setTimeout(r, 5));
      const second = session.send("queued a");
      const third = session.send("expanded queued b", { restoreText: "@queued-b.md" });

      expect(session.dequeue()).toBe("expanded queued b"); // LIFO: newest intent first
      await third; // its send resolves without ever running
      expect(session.dequeue()).toBe("queued a");
      expect(session.dequeue()).toBeNull(); // queue drained; the turn keeps running
      await second;

      release?.();
      await first;
      expect(prompts).toEqual(["slow question"]); // dequeued messages never reach the model
      expect(events.filter((event) => event.type === "turn-dequeued")).toEqual([
        { type: "turn-dequeued", text: "expanded queued b", restoreText: "@queued-b.md" },
        { type: "turn-dequeued", text: "queued a" },
      ]);
    });
  });

  test("abort ends the turn as aborted and queues an interruption notice", async () => {
    await withLog(async (log) => {
      const prompts: string[] = [];
      const events: ChatEvent[] = [];
      const session = createChatSession({
        agentFor: async () =>
          makeAgent(async (prompt, opts) => {
            prompts.push(prompt);
            if (prompts.length === 1) {
              await new Promise((_, reject) => {
                opts?.abortSignal?.addEventListener("abort", () =>
                  reject(new DOMException("Aborted", "AbortError")),
                );
              });
            }
            return result("ok");
          }),
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      const turn = session.send("long running");
      await new Promise((r) => setTimeout(r, 5));
      expect(session.abort()).toBe(true);
      expect(session.abort()).toBe(true); // repeated interrupts do not emit duplicate requests
      await turn;
      expect(
        events
          .filter(
            (event) =>
              event.type === "turn-abort-requested" ||
              event.type === "turn-aborted" ||
              event.type === "turn-finished",
          )
          .map((event) => event.type),
      ).toEqual(["turn-abort-requested", "turn-aborted", "turn-finished"]);

      await session.send("next");
      expect(prompts[1]).toContain("was interrupted");
      expect(prompts[1]).toContain("next");
    });
  });

  test("forwards internal blank lines to the agent and durable log unchanged", async () => {
    await withLog(async (log, root) => {
      const prompts: string[] = [];
      const session = createChatSession({
        agentFor: async () =>
          makeAgent(async (prompt) => {
            prompts.push(prompt);
            return result("ok");
          }),
        log,
      });
      const text = "first\n\n\n\nsecond";

      await session.send(text);

      expect(prompts).toEqual([text]);
      const loaded = await loadChatLog({ root, projectRoot: "/repo/x", id: log.id });
      expect(loaded?.turns[0]?.user).toBe(text);
    });
  });

  test("a step-limited turn queues a notice so the next turn knows it stopped early", async () => {
    await withLog(async (log) => {
      const prompts: string[] = [];
      const events: ChatEvent[] = [];
      const session = createChatSession({
        agentFor: async () =>
          makeAgent(async (prompt) => {
            prompts.push(prompt);
            return prompts.length === 1 ? result("", { stepLimitReached: true }) : result("done");
          }),
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      await session.send("big task");
      expect(
        events.find((event) => event.type === "assistant" && event.stepLimitReached),
      ).toBeDefined();

      await session.send("continue");
      expect(prompts[1]).toContain("stopped at the step limit");
      expect(prompts[1]).toContain("continue");
    });
  });

  test("turn errors surface as events and never kill the session", async () => {
    await withLog(async (log) => {
      let failures = 0;
      const events: ChatEvent[] = [];
      const session = createChatSession({
        agentFor: async () =>
          makeAgent(async () => {
            failures += 1;
            if (failures === 1) throw new Error("model exploded");
            return result("recovered");
          }),
        log,
        onEvent: (event) => {
          events.push(event);
        },
      });

      await session.send("boom");
      expect(events.some((event) => event.type === "turn-error")).toBe(true);
      expect(events.at(-1)?.type).toBe("turn-finished");
      expect(session.busy).toBe(false);

      await session.send("again");
      expect(events.filter((event) => event.type === "assistant")).toHaveLength(1);
    });
  });

  test("build turns snapshot for undo; plan turns do not", async () => {
    await withLog(async (log) => {
      const snapshots: string[] = [];
      const session = createChatSession({
        agentFor: async () => makeAgent(async () => result("done")),
        log,
        undo: {
          snapshot: async (label: string) => {
            snapshots.push(label);
            return null;
          },
          undo: async () => null,
          redo: async () => null,
          dispose: async () => {},
        },
      });

      await session.send("plan things");
      expect(snapshots).toHaveLength(0);
      session.setMode("build");
      await session.send("build things");
      expect(snapshots).toEqual(["pre-turn"]);
    });
  });
});

test("a failed turn's request survives into the next turn's notice", async () => {
  await withLog(async (log) => {
    const prompts: string[] = [];
    let failNext = true;
    const session = createChatSession({
      agentFor: async () =>
        makeAgent(async (prompt) => {
          prompts.push(prompt);
          if (failNext) {
            failNext = false;
            throw new Error("The operation timed out.");
          }
          return result("ok");
        }),
      log,
    });

    await session.send("add Orwell's rules to the base prompt");
    await session.send("try again");

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("The previous turn failed (The operation timed out.)");
    expect(prompts[1]).toContain('Its request was: "add Orwell\'s rules to the base prompt"');
    expect(prompts[1]).toContain("try again");
  });
});
