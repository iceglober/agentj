import { describe, expect, test } from "bun:test";
import type { SubagentProgressEvent } from "../agent/subagents";
import { applyProgressEvent, createProgressTracker, formatDuration } from "./progress";

const apply = (tracker: ReturnType<typeof createProgressTracker>, event: SubagentProgressEvent) =>
  applyProgressEvent(tracker, event);

describe("subagent progress", () => {
  test("retains completed, failed, and blocked task outcomes when the DAG clears", () => {
    const tracker = createProgressTracker();
    apply(tracker, {
      type: "dag-started",
      concurrency: 3,
      startedAt: 0,
      tasks: [
        { id: "t1", title: "Map modules", waitsOn: [] },
        { id: "t2", title: "Run tests", waitsOn: [] },
        { id: "t3", title: "Integrate", waitsOn: ["t2"] },
      ],
    });
    apply(tracker, {
      type: "task-usage",
      id: "t1",
      inputTokens: 1200,
      outputTokens: 300,
      contextTokens: 900,
    });
    apply(tracker, {
      type: "task-completed",
      id: "t1",
      title: "Map modules",
      elapsedMs: 2100,
    });
    apply(tracker, {
      type: "task-failed",
      id: "t2",
      title: "Run tests",
      elapsedMs: 4300,
      error: "failed",
    });
    apply(tracker, {
      type: "task-blocked",
      id: "t3",
      title: "Integrate",
      elapsedMs: 0,
      error: "blocked",
    });

    const completed = apply(tracker, { type: "dag-completed", elapsedMs: 4400 });
    expect(completed.lines).toEqual([]);
    // Columnar: usage/elapsed align on a shared left-column width (+2 gap).
    const width = "  x t3 Integrate (blocked)".length + 2;
    expect(completed.completedLines).toEqual([
      `${"  ✓ t1 Map modules".padEnd(width)}in:1.2k, out:300, ctx:900  2.1s`,
      `${"  x t2 Run tests (failed)".padEnd(width)}4.3s`,
      `${"  x t3 Integrate (blocked)".padEnd(width)}0ms`,
    ]);
    expect(tracker.live).toBe(false);

    expect(apply(tracker, { type: "dag-completed", elapsedMs: 4500 }).completedLines).toEqual([]);
  });
});

test("usage columns align across tasks with different title lengths", () => {
  const tracker = createProgressTracker();
  tracker.apply({
    type: "dag-started",
    concurrency: 2,
    startedAt: 0,
    tasks: [
      { id: "a", title: "Short", waitsOn: [] },
      { id: "b", title: "A much longer task title here", waitsOn: [] },
    ],
  });
  for (const id of ["a", "b"]) {
    tracker.apply({ type: "task-started", id, title: "", startedAt: 0 });
    tracker.apply({
      type: "task-usage",
      id,
      inputTokens: 1000,
      outputTokens: 10,
      contextTokens: 1000,
    });
  }
  const lines = tracker.lines();
  expect(lines[0]?.indexOf("in:")).toBe(lines[1]?.indexOf("in:"));

  // Overlong titles are clamped so padded lines stay repaint-safe.
  tracker.apply({
    type: "dag-started",
    concurrency: 1,
    startedAt: 0,
    tasks: [{ id: "long", title: "x".repeat(120), waitsOn: [] }],
  });
  const clamped = tracker.lines();
  expect(clamped[0]?.length).toBeLessThanOrEqual(48);
  expect(clamped[0]).toContain("…");
});

test("formatDuration uses ms under a second", () => {
  expect(formatDuration(0)).toBe("0ms");
  expect(formatDuration(340)).toBe("340ms");
  expect(formatDuration(999)).toBe("999ms");
  expect(formatDuration(2140)).toBe("2.1s");
  expect(formatDuration(74_200)).toBe("74.2s");
});
