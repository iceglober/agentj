import { describe, expect, test } from "bun:test";
import {
  composeProgressLines,
  composeStatusSection,
  finalizeInteractiveChat,
  formatChatEvent,
  formatClock,
  formatResumeCommand,
  truncateLineWithNotice,
} from "./agent-loop";

describe("interactive chat shutdown", () => {
  test("formats the exact resume command", () => {
    expect(formatResumeCommand("204ed50c")).toBe("Resume with: agentj --resume 204ed50c\n");
  });

  test("prints the resume command after terminal and composition cleanup", async () => {
    const events: string[] = [];
    await finalizeInteractiveChat({
      sessionId: "204ed50c",
      settle: Promise.resolve(),
      stopScreen: () => events.push("screen stopped"),
      closeComposition: async () => {
        events.push("composition closed");
      },
      write: (text) => events.push(text.trim()),
    });

    expect(events).toEqual([
      "screen stopped",
      "composition closed",
      "Resume with: agentj --resume 204ed50c",
    ]);
  });

  test("still cleans up and prints when session work fails", async () => {
    const events: string[] = [];
    const failure = new Error("TUI crashed");
    const result = finalizeInteractiveChat({
      sessionId: "204ed50c",
      settle: Promise.reject(failure),
      stopScreen: () => events.push("screen stopped"),
      closeComposition: async () => {
        events.push("composition closed");
      },
      write: (text) => events.push(text.trim()),
    });

    await expect(result).rejects.toBe(failure);
    expect(events).toEqual([
      "screen stopped",
      "composition closed",
      "Resume with: agentj --resume 204ed50c",
    ]);
  });
});

describe("truncateLineWithNotice", () => {
  test("reserves room for a consistent omitted-character notice", () => {
    expect(truncateLineWithNotice("abcdefghijklmnopqrstuvwxyz", 20)).toBe("abc [trunc 23 chars]");
    expect(Array.from(truncateLineWithNotice("🙂".repeat(30), 20))).toHaveLength(20);
    expect(truncateLineWithNotice("🙂".repeat(30), 20)).toBe("🙂🙂🙂 [trunc 27 chars]");
  });

  test("turns multiline previews into one line without marking untruncated text", () => {
    expect(truncateLineWithNotice("alpha\nbeta", 20)).toBe("alpha beta");
  });
});

describe("formatChatEvent", () => {
  test("preserves multiline user messages in transcript output", () => {
    const text = "first\n\n\n\nsecond";
    expect(formatChatEvent({ type: "turn-started", mode: "plan", text })).toBe(`> ${text}`);
  });

  test("uses command labels instead of internal slash-command prompts", () => {
    expect(formatChatEvent({ type: "command", name: "help" })).toBe("Command: help");
    expect(
      formatChatEvent({
        type: "turn-started",
        mode: "build",
        text: "internal implementation prompt",
        transcriptText: "Command: build",
      }),
    ).toBe("Command: build");
  });

  test("keeps turn lifecycle-only events out of the transcript", () => {
    expect(formatChatEvent({ type: "turn-abort-requested" })).toBeNull();
    expect(formatChatEvent({ type: "turn-finished" })).toBeNull();
  });

  test("trims assistant bodies and drops empty ones (no blank transcript rows)", () => {
    expect(formatChatEvent({ type: "assistant", mode: "plan", text: "" })).toBeNull();
    expect(formatChatEvent({ type: "assistant", mode: "plan", text: "  \n\n" })).toBeNull();
    expect(formatChatEvent({ type: "assistant", mode: "plan", text: "done.\n\n" })).toBe("done.");
    // Internal blank lines survive — only the edges are trimmed.
    expect(formatChatEvent({ type: "assistant", mode: "plan", text: "\na\n\nb\n" })).toBe("a\n\nb");
  });

  test("a step-limited turn is announced instead of ending silently", () => {
    expect(
      formatChatEvent({ type: "assistant", mode: "build", text: "", stepLimitReached: true }),
    ).toBe(
      '(step limit reached — turn stopped mid-work; send "continue" to resume, or raise agent.steps)',
    );
    expect(
      formatChatEvent({
        type: "assistant",
        mode: "build",
        text: "partial\n",
        stepLimitReached: true,
      }),
    ).toBe(
      'partial\n(step limit reached — turn stopped mid-work; send "continue" to resume, or raise agent.steps)',
    );
  });

  test("labels dequeued messages with their first line only", () => {
    expect(formatChatEvent({ type: "turn-dequeued", text: "do the thing\nwith detail" })).toBe(
      "(dequeued) do the thing",
    );
  });
});

describe("composeProgressLines", () => {
  const tools = (
    entries: Array<[number, string, string?]>,
  ): Array<[number, { tool: string; detail: string }]> =>
    entries.map(([id, tool, detail]) => [id, { tool, detail: detail ?? "" }]);

  test("a tool's DAG block nests directly beneath its head row", () => {
    const lines = composeProgressLines({
      activeTools: tools([[1, "run_subagents", '{"tasks":[…]}']]),
      dagBlocks: new Map([[1, ["    ◐ t1 One", "    · t2 Two"]]]),
      queued: ["  ↳ queued: next"],
      spinnerFrame: 0,
    });
    expect(lines).toEqual([
      "  ◐ run_subagents",
      "    ◐ t1 One",
      "    · t2 Two",
      "  ↳ queued: next",
    ]);
  });

  test("concurrent owners keep their blocks separate, in tool start order", () => {
    const lines = composeProgressLines({
      activeTools: tools([
        [1, "run_subagents"],
        [2, "readFile", "a.ts"],
        [3, "run_subagents"],
      ]),
      dagBlocks: new Map([
        [3, ["    ◐ y1 Late"]],
        [1, ["    ◐ x1 Early"]],
      ]),
      queued: [],
      spinnerFrame: 0,
    });
    expect(lines).toEqual([
      "  ◐ run_subagents",
      "    ◐ x1 Early",
      "  ◐ readFile a.ts",
      "  ◐ run_subagents",
      "    ◐ y1 Late",
    ]);
  });

  test("ownerless blocks render first, un-nested", () => {
    const lines = composeProgressLines({
      activeTools: tools([[5, "bash", "ls"]]),
      dagBlocks: new Map([[-1, ["  ◐ t1 Orphan"]]]),
      queued: [],
      spinnerFrame: 0,
    });
    expect(lines).toEqual(["  ◐ t1 Orphan", "  ◐ bash ls"]);
  });
});

describe("formatClock", () => {
  test("scales units with elapsed time", () => {
    expect(formatClock(9_000)).toBe("9s");
    expect(formatClock(74_000)).toBe("1m14s");
    expect(formatClock(3.5 * 3_600_000)).toBe("3h30m");
    expect(formatClock(30 * 3_600_000)).toBe("1d6h0m");
  });
});

describe("composeStatusSection", () => {
  const base = {
    sessionId: "204ed50c",
    root: "~/repos/agentj",
    model: "azure/gpt-5.6-sol",
    mode: "plan" as const,
    busy: false,
    interruptRequested: false,
    spinnerFrame: 0,
    turnStartedAt: null,
    currentActivity: null,
    usage: { in: 12_400, out: 3_100, ctx: 8_700 },
    sessionStartedAt: 0,
    jobs: [],
    now: 74_000,
  };

  test("idle: identity with right-aligned counters, then the root path", () => {
    const lines = composeStatusSection(base, 90);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith("204ed50c · azure/gpt-5.6-sol · plan (tab↕)")).toBe(true);
    expect(lines[0]?.endsWith("in 12.4k ▸ out 3.1k · ctx 8.7k · 1m14s")).toBe(true);
    expect(lines[0]?.length).toBe(90);
    expect(lines[1]).toBe("~/repos/agentj");
  });

  test("narrow terminals drop counter labels before truncating anything", () => {
    const lines = composeStatusSection(base, 66);
    expect(lines[0]).toContain("12.4k▸3.1k·8.7k·1m14s");
    expect(lines[0]).not.toContain("in 12.4k");
  });

  test("busy: the indicator takes line 2's right end and the path yields", () => {
    const lines = composeStatusSection(
      {
        ...base,
        busy: true,
        turnStartedAt: 62_000,
        currentActivity: { id: 1, tool: "run_subagents", detail: "3 tasks", phase: "start" },
        root: `~/${"deep/".repeat(30)}repo`,
      },
      80,
    );
    expect(lines[1]).toContain("◐ run_subagents (3 tasks) 12s (esc)");
    expect(lines[1]?.length).toBeLessThanOrEqual(80);
    expect(lines[1]).toContain("…");
  });

  test("running jobs each get a row below the section", () => {
    const lines = composeStatusSection(
      {
        ...base,
        jobs: [
          { id: "j1", mode: "build", prompt: "refactor the auth flow\nwith detail", startedAt: 0 },
        ],
      },
      90,
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("  ◐ [j1] build: refactor the auth flow  1m14s");
  });
});
