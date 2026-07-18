import { describe, expect, test } from "bun:test";
import { type BackgroundJobPort, createBackgroundJobTool } from "./background-jobs";

const recordingPort = (): BackgroundJobPort & {
  calls: Array<{ mode: string; prompt: string }>;
} => {
  const calls: Array<{ mode: string; prompt: string }> = [];
  return {
    calls,
    start(mode, prompt) {
      calls.push({ mode, prompt });
      return { id: `j${calls.length}` };
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
      { start: () => ({ error: "Background jobs are unavailable in this session." }) },
      "build",
    );
    expect(await tool.execute({ prompt: "x" })).toBe(
      "Background jobs are unavailable in this session.",
    );
  });
});
