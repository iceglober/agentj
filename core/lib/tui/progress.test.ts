import { describe, expect, test } from "bun:test";
import type { SubagentProgressEvent } from "../agent/subagents";
import {
  applyProgressEvent,
  composeProgressLines,
  countVisibleToolActivities,
  createProgressTracker,
  formatDuration,
  formatToolActivityLabel,
} from "./progress";

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
      message: "mapped modules",
    });
    apply(tracker, {
      type: "task-failed",
      id: "t2",
      title: "Run tests",
      elapsedMs: 4300,
      message: "failed",
      error: "failed",
    });
    apply(tracker, {
      type: "task-blocked",
      id: "t3",
      title: "Integrate",
      elapsedMs: 0,
      message: "blocked",
      error: "blocked",
    });

    const completed = apply(tracker, { type: "dag-completed", elapsedMs: 4400 });
    expect(completed.lines).toEqual([]);
    // Columnar: usage/elapsed align on a shared left-column width (+2 gap).
    const width = "  x t3 Integrate (blocked)".length + 2;
    expect(completed.completedLines).toEqual([
      `${"  ✓ t1 Map modules".padEnd(width)}in:1.2k, out:300, ctx:900  2.1s`,
      "    ↳ mapped modules",
      `${"  x t2 Run tests (failed)".padEnd(width)}4.3s`,
      "    ↳ failed",
      `${"  x t3 Integrate (blocked)".padEnd(width)}0ms`,
      "    ↳ blocked",
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

test("started tasks render in execution order; unstarted trail in declaration order", () => {
  const tracker = createProgressTracker();
  tracker.apply({
    type: "dag-started",
    concurrency: 3,
    startedAt: 0,
    tasks: [
      { id: "t1", title: "One", waitsOn: [] },
      { id: "t2", title: "Two", waitsOn: [] },
      { id: "t3", title: "Three", waitsOn: ["t1"] },
    ],
  });
  tracker.apply({ type: "task-started", id: "t2", title: "Two", startedAt: 1 });
  tracker.apply({ type: "task-started", id: "t1", title: "One", startedAt: 2 });
  expect(tracker.lines().map((line) => line.trim().slice(2))).toEqual([
    "t2 Two",
    "t1 One",
    "t3 Three · waits on t1",
  ]);

  // Finishing does not move a task; it holds its execution-order slot.
  tracker.apply({
    type: "task-completed",
    id: "t2",
    title: "Two",
    elapsedMs: 5,
    message: "done",
  });
  expect(
    tracker
      .lines()
      .filter((line) => !line.includes("↳"))
      .map((line) => line.trim().slice(2, 4))
      .slice(0, 2),
  ).toEqual(["t2", "t1"]);
});

test("indent widens the left column and still clamps at the same right edge", () => {
  const tracker = createProgressTracker();
  tracker.apply({
    type: "dag-started",
    concurrency: 1,
    startedAt: 0,
    tasks: [{ id: "t1", title: "x".repeat(120), waitsOn: [] }],
  });
  expect(tracker.lines(0)[0]?.startsWith("  · t1")).toBe(true);
  const nested = tracker.lines(0, 4);
  expect(nested[0]?.startsWith("    · t1")).toBe(true);
  expect(nested[0]?.length).toBeLessThanOrEqual(48);
  expect(nested[0]).toContain("…");
});

test("tasks launched on a different model carry the label in the right column", () => {
  const tracker = createProgressTracker();
  tracker.apply({
    type: "dag-started",
    concurrency: 2,
    startedAt: 0,
    tasks: [
      { id: "a", title: "Routed", waitsOn: [], model: "azure/gpt-5-mini" },
      { id: "b", title: "Plain", waitsOn: [] },
    ],
  });
  const lines = tracker.lines();
  expect(lines[0]).toContain("(azure/gpt-5-mini)");
  expect(lines[1]).not.toContain("(azure/gpt-5-mini)");
});

describe("tool activity", () => {
  const tools = (
    entries: Array<[number, string, string?]>,
  ): Array<[number, { tool: string; detail: string }]> =>
    entries.map(([id, tool, detail]) => [id, { tool, detail: detail ?? "" }]);

  test("keeps rapid tools out of the live region until they have lasted 250ms", () => {
    const now = 1_000;
    const activeTools: Array<[number, { tool: string; detail: string; startedAt: number }]> = [
      [1, { tool: "bash", detail: "quick", startedAt: now - 249 }],
      [2, { tool: "readFile", detail: "slow", startedAt: now - 250 }],
    ];
    expect(
      composeProgressLines({
        activeTools,
        dagBlocks: new Map([
          [1, ["    ◐ quick child"]],
          [2, ["    ◐ slow child"]],
        ]),
        queued: [],
        spinnerFrame: 0,
        now,
      }),
    ).toEqual(["  ◐ readFile slow", "    ◐ slow child"]);
    expect(countVisibleToolActivities(activeTools, now)).toBe(1);
  });

  test("keeps each tool's basic arguments on live rows", () => {
    const lines = composeProgressLines({
      activeTools: tools([
        [1, "bash", "git status --short"],
        [2, "run_subagents", "3 tasks"],
      ]),
      dagBlocks: new Map([[2, ["    ◐ t1 Map modules"]]]),
      queued: [],
      spinnerFrame: 0,
    });
    expect(lines).toEqual([
      "  ◐ bash git status --short",
      "  ◐ run_subagents 3 tasks",
      "    ◐ t1 Map modules",
    ]);
  });

  test("keeps DAG blocks with their owner in tool start order", () => {
    const lines = composeProgressLines({
      activeTools: tools([
        [1, "run_subagents", "2 tasks"],
        [2, "readFile", "a.ts"],
        [3, "run_subagents", "1 task"],
      ]),
      dagBlocks: new Map([
        [3, ["    ◐ y1 Late"]],
        [1, ["    ◐ x1 Early"]],
      ]),
      queued: [],
      spinnerFrame: 0,
    });
    expect(lines).toEqual([
      "  ◐ run_subagents 2 tasks",
      "    ◐ x1 Early",
      "  ◐ readFile a.ts",
      "  ◐ run_subagents 1 task",
      "    ◐ y1 Late",
    ]);
  });

  test("renders ownerless blocks first", () => {
    expect(
      composeProgressLines({
        activeTools: tools([[5, "bash", "ls"]]),
        dagBlocks: new Map([[-1, ["  ◐ t1 Orphan"]]]),
        queued: [],
        spinnerFrame: 0,
      }),
    ).toEqual(["  ◐ t1 Orphan", "  ◐ bash ls"]);
  });

  test("separates the todo panel from live activity only when both exist", () => {
    const base = {
      activeTools: tools([[1, "bash", "git status --short"]]),
      dagBlocks: new Map<number, string[]>(),
      queued: [],
      spinnerFrame: 0,
    };
    expect(
      composeProgressLines({
        ...base,
        todos: ["  ╭─ Todos 0/1 done", "  ╰────────────────────"],
      }),
    ).toEqual([
      "  ◐ bash git status --short",
      "",
      "  ╭─ Todos 0/1 done",
      "  ╰────────────────────",
    ]);
    expect(composeProgressLines({ ...base, todos: [] })).toEqual(["  ◐ bash git status --short"]);
    expect(
      composeProgressLines({
        todos: ["  ╭─ Todos 0/1 done", "  ╰────────────────────"],
        activeTools: [],
        dagBlocks: new Map(),
        queued: [],
        spinnerFrame: 0,
      }),
    ).toEqual(["  ╭─ Todos 0/1 done", "  ╰────────────────────"]);
  });

  test("formats completed labels as safe one-line previews", () => {
    expect(formatToolActivityLabel("bash", "git status\n--short")).toBe("bash git status --short");
    const preview = formatToolActivityLabel("bash", "x".repeat(200), 20);
    expect(preview).toStartWith("bash ");
    expect(preview).toContain("[trunc");
    expect(preview).not.toContain("\n");
  });
});

test("formatDuration uses ms under a second", () => {
  expect(formatDuration(0)).toBe("0ms");
  expect(formatDuration(340)).toBe("340ms");
  expect(formatDuration(999)).toBe("999ms");
  expect(formatDuration(2140)).toBe("2.1s");
  expect(formatDuration(74_200)).toBe("74.2s");
});
