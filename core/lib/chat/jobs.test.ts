import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "./events";
import { createJobRunner } from "./jobs";

describe("createJobRunner", () => {
  test("runs jobs to completion, emits events, and queues turn notices", async () => {
    const events: ChatEvent[] = [];
    const notices: string[] = [];
    let releaseJob: (() => void) | undefined;
    const runner = createJobRunner({
      runJob: async ({ prompt }) => {
        await new Promise<void>((resolve) => {
          releaseJob = resolve;
        });
        return { text: `did: ${prompt}` };
      },
      onEvent: (event) => {
        events.push(event);
      },
      addTurnNotice: (text) => {
        notices.push(text);
      },
      now: (() => {
        let tick = 0;
        return () => (tick += 1000);
      })(),
    });

    const job = runner.start("build", "refactor the config tests");
    expect(job.id).toBe("j1");
    expect(runner.list()[0]?.status).toBe("running");

    releaseJob?.();
    await new Promise((r) => setTimeout(r, 5));

    expect(runner.list()[0]).toMatchObject({ status: "done" });
    expect(events.map((event) => event.type)).toEqual(["job-started", "job-finished"]);
    expect(notices[0]).toContain("[j1] finished");
    expect(notices[0]).toContain("did: refactor");
  });

  test("parses completion reports before notifying the user and completing session state", async () => {
    const notices: string[] = [];
    const completed: ChatEvent[] = [];
    const runner = createJobRunner({
      runJob: async () => ({
        text: JSON.stringify({
          status: "done",
          summary: "PR #124 merged successfully.",
          changes: ["Merged after green CI"],
          validation: [],
          openQuestions: [],
        }),
      }),
      addTurnNotice: (text) => {
        notices.push(text);
      },
      onJobCompleted: (job) => {
        completed.push({ type: "job-finished", job });
      },
    });

    runner.start("build", "watch CI and merge the PR");
    await new Promise((r) => setTimeout(r, 5));

    const job = runner.inspect("j1");
    expect(job).toMatchObject({
      status: "done",
      resultText: "PR #124 merged successfully.",
      completion: { status: "done", summary: "PR #124 merged successfully." },
    });
    expect(notices[0]).toContain("PR #124 merged successfully.");
    expect(notices[0]).not.toContain('{"status"');
    expect(completed).toHaveLength(1);
  });

  test("resolved executor failures are reported as failed", async () => {
    const notices: string[] = [];
    const runner = createJobRunner({
      runJob: async () => ({ text: "child worktree setup failed", status: "failed" }),
      addTurnNotice: (text) => {
        notices.push(text);
      },
    });

    runner.start("build", "ship the change");
    await new Promise((r) => setTimeout(r, 5));

    expect(runner.list()[0]).toMatchObject({
      status: "failed",
      resultText: "child worktree setup failed",
    });
    expect(notices[0]).toContain("[j1] failed");
  });

  test("failures and aborts are reported, dispose aborts running jobs", async () => {
    const notices: string[] = [];
    const runner = createJobRunner({
      runJob: async ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      addTurnNotice: (text) => {
        notices.push(text);
      },
    });

    runner.start("plan", "research something");
    const missing = runner.abort("j9");
    expect(missing).toBe(false);
    expect(runner.abort("j1")).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.list()[0]?.status).toBe("aborted");

    runner.start("plan", "another");
    runner.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.list()[1]?.status).toBe("aborted");
    expect(notices).toHaveLength(2);
  });

  test("soft timeout pings only while running, and renew re-arms the ping", async () => {
    const pings: string[] = [];
    let release: (() => void) | undefined;
    const runner = createJobRunner({
      runJob: async ({ onStep }) => {
        onStep?.({
          toolCalls: [{ name: "bash", input: { command: "bun test core" } }],
          toolResults: [],
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text: "ok" };
      },
      addTurnNotice: () => {},
      ping: (job) => pings.push(job.id),
    });

    runner.start("build", "run the tests", { softTimeoutMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    expect(pings).toEqual(["j1"]);

    const inspected = runner.inspect("j1");
    expect(inspected?.status).toBe("running");
    expect(inspected?.recentActivity).toEqual(["bash bun test core"]);
    expect(inspected?.softTimeoutAt).toBeNumber();

    expect(runner.renewSoftTimeout("j1", 30)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(pings).toEqual(["j1", "j1"]);

    release?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.inspect("j1")?.status).toBe("done");
    expect(runner.renewSoftTimeout("j1", 30)).toBe(false);
  });

  test("a job that finishes before its soft timeout never pings", async () => {
    const pings: string[] = [];
    const runner = createJobRunner({
      runJob: async () => ({ text: "fast" }),
      addTurnNotice: () => {},
      ping: (job) => pings.push(job.id),
    });
    runner.start("plan", "quick check", { softTimeoutMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    expect(pings).toEqual([]);
  });

  test("the activity trail is bounded and counts what it dropped", async () => {
    const runner = createJobRunner({
      runJob: async ({ onStep }) => {
        for (let call = 0; call < 40; call += 1) {
          onStep?.({
            toolCalls: [{ name: "bash", input: { command: `step ${call}` } }],
            toolResults: [],
          });
        }
        return { text: "ok" };
      },
      addTurnNotice: () => {},
    });
    runner.start("plan", "busy job");
    await new Promise((r) => setTimeout(r, 5));
    const trail = runner.inspect("j1")?.recentActivity ?? [];
    expect(trail).toHaveLength(31);
    expect(trail[0]).toBe("… 10 earlier tool calls omitted");
    expect(trail.at(-1)).toBe("bash step 39");
    expect(runner.inspect("j9")).toBeUndefined();
  });

  test("cleanup warnings and preserved branches surface without failing the job", async () => {
    const notices: string[] = [];
    const runner = createJobRunner({
      runJob: async () => ({
        text: "completed",
        branch: "agentj/j1-work",
        warnings: ["git worktree remove --force /child exited 1: busy"],
      }),
      addTurnNotice: (text) => {
        notices.push(text);
      },
    });
    runner.start("build", "big refactor");
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.inspect("j1")).toMatchObject({
      status: "done",
      warnings: ["git worktree remove --force /child exited 1: busy"],
    });
    expect(notices[0]).toContain("work preserved on agentj/j1-work");
    expect(notices[0]).toContain("warning: git worktree remove --force /child exited 1: busy");
  });
});
