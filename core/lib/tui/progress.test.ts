import { describe, expect, test } from "bun:test";
import { createProgressTracker } from "./progress";

describe("createProgressTracker", () => {
  test("renders live usage while running and freezes it with elapsed when done", () => {
    const tracker = createProgressTracker();
    tracker.apply({
      type: "dag-started",
      concurrency: 2,
      startedAt: 0,
      tasks: [
        { id: "a", title: "Research A", waitsOn: [] },
        { id: "b", title: "Research B", waitsOn: ["a"] },
      ],
    });
    tracker.apply({ type: "task-started", id: "a", title: "Research A", startedAt: 0 });
    tracker.apply({
      type: "task-usage",
      id: "a",
      inputTokens: 2437,
      outputTokens: 987,
      contextTokens: 2137,
    });

    let lines = tracker.lines();
    expect(lines[0]).toContain("in:2.4k, out:987, ctx:2.1k");
    expect(lines[1]).toContain("waits on a");

    tracker.apply({
      type: "task-usage",
      id: "a",
      inputTokens: 432_312,
      outputTokens: 43_210,
      contextTokens: 399_876,
    });
    tracker.apply({ type: "task-completed", id: "a", title: "Research A", elapsedMs: 74_200 });

    lines = tracker.lines();
    expect(lines[0]).toContain("✓ a Research A");
    // Frozen usage plus elapsed survive completion.
    expect(lines[0]).toContain("in:432.3k, out:43.2k, ctx:399.9k");
    expect(lines[0]).toContain("74.2s");

    tracker.apply({ type: "dag-completed", elapsedMs: 80_000 });
    expect(tracker.lines()).toEqual([]);
    expect(tracker.live).toBe(false);
  });

  test("tasks without usage render without a usage suffix", () => {
    const tracker = createProgressTracker();
    tracker.apply({
      type: "dag-started",
      concurrency: 1,
      startedAt: 0,
      tasks: [{ id: "t1", title: "Quick", waitsOn: [] }],
    });
    tracker.apply({ type: "task-started", id: "t1", title: "Quick", startedAt: 0 });
    expect(tracker.lines()[0]).not.toContain("in:");
  });
});
