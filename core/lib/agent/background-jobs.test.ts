import { describe, expect, test } from "bun:test";
import {
  type BackgroundJobInspection,
  type BackgroundJobPort,
  createBackgroundJobTool,
  createCheckJobTool,
} from "./background-jobs";

const recordingPort = (
  inspection?: Partial<BackgroundJobInspection>,
): BackgroundJobPort & {
  calls: Array<{ mode: string; prompt: string; softTimeoutMs?: number }>;
  renewals: Array<{ id: string; softTimeoutMs: number }>;
  aborted: string[];
} => {
  const calls: Array<{ mode: string; prompt: string; softTimeoutMs?: number }> = [];
  const renewals: Array<{ id: string; softTimeoutMs: number }> = [];
  const aborted: string[] = [];
  return {
    calls,
    renewals,
    aborted,
    start(mode, prompt, options) {
      calls.push({ mode, prompt, ...(options?.softTimeoutMs ? options : {}) });
      return { id: `j${calls.length}` };
    },
    inspect(id) {
      if (!inspection) return undefined;
      return {
        id,
        status: "running",
        prompt: "run the tests",
        startedAt: 0,
        recentActivity: [],
        ...inspection,
      };
    },
    renewSoftTimeout(id, softTimeoutMs) {
      renewals.push({ id, softTimeoutMs });
      return true;
    },
    abort(id) {
      aborted.push(id);
      return true;
    },
  };
};

describe("run_job tool", () => {
  test("build agents default to build jobs and report the id without waiting", async () => {
    const port = recordingPort();
    const tool = createBackgroundJobTool(port, "build");
    const result = await tool.execute({ prompt: "wait for CI on PR 12, then fix failures" });
    expect(result).toContain("j1 (build)");
    expect(result).toContain("Do not wait");
    expect(port.calls).toEqual([
      { mode: "build", prompt: "wait for CI on PR 12, then fix failures" },
    ]);
  });

  test("a soft timeout is forwarded in ms and echoed back as the ping contract", async () => {
    const port = recordingPort();
    const tool = createBackgroundJobTool(port, "build");
    const result = await tool.execute({ prompt: "run the slow suite", softTimeoutMinutes: 8 });
    expect(result).toContain("pinged if it is still running after 8 minutes");
    expect(port.calls).toEqual([
      { mode: "build", prompt: "run the slow suite", softTimeoutMs: 8 * 60_000 },
    ]);
  });

  test("plan agents may only start read-only plan jobs", async () => {
    const port = recordingPort();
    const tool = createBackgroundJobTool(port, "plan");
    expect(await tool.execute({ mode: "build", prompt: "x" })).toContain(
      "only start plan (read-only) jobs",
    );
    expect(port.calls).toEqual([]);
    expect(await tool.execute({ prompt: "watch the deploy" })).toContain("(plan)");
    expect(port.calls).toEqual([{ mode: "plan", prompt: "watch the deploy" }]);
  });

  test("an unavailable runner surfaces its error as the tool result", async () => {
    const tool = createBackgroundJobTool(
      {
        ...recordingPort(),
        start: () => ({ error: "Background jobs are unavailable in this session." }),
      },
      "build",
    );
    expect(await tool.execute({ prompt: "x" })).toBe(
      "Background jobs are unavailable in this session.",
    );
  });
});

describe("check_job tool", () => {
  test("unknown jobs report cleanly", async () => {
    const tool = createCheckJobTool(recordingPort());
    expect(await tool.execute({ id: "j9" })).toBe("No background job j9 in this session.");
  });

  test("a running job shows elapsed time, overdue soft timeout, and activity", async () => {
    const port = recordingPort({
      softTimeoutAt: 8 * 60_000,
      recentActivity: ["bash bun test core", "readFile core/agent-loop.ts"],
    });
    const tool = createCheckJobTool(port, () => 9 * 60_000);
    const result = (await tool.execute({ id: "j1" })) as string;
    expect(result).toContain("[j1] running — 9m0s — run the tests");
    expect(result).toContain("soft timeout passed 1m0s ago");
    expect(result).toContain("  bash bun test core");
    expect(port.renewals).toEqual([]);
    expect(port.aborted).toEqual([]);
  });

  test("renewing forwards minutes as ms and reports the new ping contract", async () => {
    const port = recordingPort({});
    const tool = createCheckJobTool(port, () => 0);
    const result = (await tool.execute({ id: "j1", renewSoftTimeoutMinutes: 10 })) as string;
    expect(result).toContain("pinged again in 10 minutes");
    expect(port.renewals).toEqual([{ id: "j1", softTimeoutMs: 10 * 60_000 }]);
  });

  test("abort wins over renew and reports the kill", async () => {
    const port = recordingPort({});
    const tool = createCheckJobTool(port, () => 0);
    const result = (await tool.execute({
      id: "j1",
      abort: true,
      renewSoftTimeoutMinutes: 5,
    })) as string;
    expect(result).toContain("Aborted j1.");
    expect(port.aborted).toEqual(["j1"]);
    expect(port.renewals).toEqual([]);
  });

  test("a finished job shows its result and cleanup warnings", async () => {
    const port = recordingPort({
      status: "done",
      endedAt: 6 * 60_000,
      resultText: "all 443 tests passed",
      warnings: ["git worktree remove --force /child exited 1: busy"],
    });
    const tool = createCheckJobTool(port, () => 9 * 60_000);
    const result = (await tool.execute({ id: "j1" })) as string;
    expect(result).toContain("[j1] done — 6m0s");
    expect(result).toContain("result: all 443 tests passed");
    expect(result).toContain("warnings:\n  git worktree remove --force /child exited 1: busy");
    expect(result).not.toContain("soft timeout");
  });
});
