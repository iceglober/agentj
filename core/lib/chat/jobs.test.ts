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
    expect(notices[0]).toContain("[j1] done");
    expect(notices[0]).toContain("did: refactor");
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

  test("preserved branches surface in the notice", async () => {
    const notices: string[] = [];
    const runner = createJobRunner({
      runJob: async () => ({ text: "blocked integration", branch: "agentj/j1-work" }),
      addTurnNotice: (text) => {
        notices.push(text);
      },
    });
    runner.start("build", "big refactor");
    await new Promise((r) => setTimeout(r, 5));
    expect(notices[0]).toContain("work preserved on agentj/j1-work");
  });
});
