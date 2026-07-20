import { describe, expect, test } from "bun:test";
import {
  composeProgressLines,
  composeStatusSection,
  composeThinkingLine,
  createUpdateRestartOptions,
  finalizeInteractiveChat,
  formatChatEvent,
  formatClock,
  formatResumeCommand,
  shouldWarnContext,
  truncateLineWithNotice,
} from "./agent-loop";

describe("update restart", () => {
  test("inherits terminal streams and marks the restarted process", () => {
    expect(
      createUpdateRestartOptions(["--continue"], {
        executable: "/bun",
        script: "/app/bin/agentj",
        env: { PATH: "/bin", AGENTJ_UPDATE_RESTARTED: undefined },
      }),
    ).toEqual({
      cmd: ["/bun", "/app/bin/agentj", "--continue"],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { PATH: "/bin", AGENTJ_UPDATE_RESTARTED: "1" },
    });
  });
});

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

  test("runs a requested update only after terminal teardown", async () => {
    const events: string[] = [];
    await finalizeInteractiveChat({
      sessionId: undefined,
      settle: Promise.resolve(),
      stopScreen: () => events.push("screen stopped"),
      closeComposition: async () => {
        events.push("composition closed");
      },
      afterClose: async () => {
        events.push("updated");
      },
    });
    expect(events).toEqual(["screen stopped", "composition closed", "updated"]);
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

  test("renders every completion-report field instead of only its summary", () => {
    expect(
      formatChatEvent({
        type: "assistant",
        mode: "plan",
        text: JSON.stringify({
          status: "done",
          summary: "plan ready",
          changes: ["Scanned editor tokens"],
          validation: [{ command: "bun test core", outcome: "passed", evidence: "green" }],
          openQuestions: ["None"],
        }),
      }),
    ).toBe(
      "✓ plan ready\n\nChanges:\n- Scanned editor tokens\n\nValidation:\n- ✓ bun test core: green\n\nOpen questions:\n- None",
    );
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

  test("reports completed jobs with their actual runtime and outcome", () => {
    expect(
      formatChatEvent({
        type: "job-finished",
        job: {
          id: "j2",
          mode: "build",
          prompt: "monitor the release workflow",
          status: "done",
          startedAt: 0,
          endedAt: 74_000,
          resultText: "Package published.",
        },
      }),
    ).toBe("✓ [j2] done in 1m14s — monitor the release workflow\nPackage published.");
  });

  test("marks failed jobs as failures", () => {
    expect(
      formatChatEvent({
        type: "job-finished",
        job: {
          id: "j2",
          mode: "build",
          prompt: "monitor the release workflow",
          status: "failed",
          startedAt: 0,
          endedAt: 1_000,
          resultText: "Child worktree setup failed.",
        },
      }),
    ).toBe("x [j2] failed in 1s — monitor the release workflow\nChild worktree setup failed.");
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

describe("shouldWarnContext", () => {
  test("fires at the threshold and re-arms after meaningful context growth", () => {
    expect(shouldWarnContext(239_999, 240_000, undefined)).toBe(false);
    expect(shouldWarnContext(240_000, 240_000, undefined)).toBe(true);
    expect(shouldWarnContext(263_999, 240_000, 240_000)).toBe(false);
    expect(shouldWarnContext(264_000, 240_000, 240_000)).toBe(true);
    expect(shouldWarnContext(300_000, undefined, undefined)).toBe(false);
  });
});

describe("composeStatusSection", () => {
  const base = {
    sessionId: "204ed50c",
    root: "~/repos/agentj",
    model: "azure/gpt-5.6-sol",
    mode: "plan" as const,
    spinnerFrame: 0,
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

  test("session cache reads ride next to the input counter as a share of cumulative input", () => {
    const lines = composeStatusSection(
      { ...base, usage: { ...base.usage, cacheRead: 8_030 } },
      110,
    );
    // 8 030 of the 12 400 cumulative input tokens came from the cache → 65%.
    expect(lines[0]).toContain("in 12.4k · cached 8.0k(65%) ▸ out 3.1k");
  });

  test("the compact form drops the cache stat, width wins", () => {
    const lines = composeStatusSection({ ...base, usage: { ...base.usage, cacheRead: 8_030 } }, 66);
    expect(lines[0]).toContain("12.4k▸3.1k·8.7k·1m14s");
    expect(lines[0]).not.toContain("cached");
  });

  test("ctx renders flagged once it reaches the configured soft limit", () => {
    const under = composeStatusSection({ ...base, contextSoftLimit: 10_000 }, 90);
    expect(under[0]).toContain("ctx 8.7k ·");
    const over = composeStatusSection({ ...base, contextSoftLimit: 8_000 }, 90);
    expect(over[0]).toContain("ctx 8.7k!");
  });

  test("thinking renders above the editor rather than in the status section", () => {
    const line = composeThinkingLine(
      {
        thinking: true,
        interruptRequested: false,
        spinnerFrame: 0,
        turnStartedAt: 62_000,
        now: 74_000,
      },
      80,
    );
    expect(line).toBe("◐ thinking 12s (esc)");
    expect(
      composeStatusSection({ ...base, root: `~/${"deep/".repeat(30)}repo` }, 80)[1],
    ).not.toContain("thinking");
    expect(
      composeThinkingLine(
        { thinking: false, interruptRequested: false, spinnerFrame: 0, turnStartedAt: null },
        80,
      ),
    ).toBeNull();
  });

  test("running jobs render individual rows below the status", () => {
    const lines = composeStatusSection(
      {
        ...base,
        jobs: [
          { id: "j1", mode: "build", prompt: "Run the test suite", startedAt: 50_000 },
          { id: "j2", mode: "plan", prompt: "Investigate the failure", startedAt: 60_000 },
        ],
      },
      90,
    );
    expect(lines).toEqual([
      expect.stringContaining("204ed50c · azure/gpt-5.6-sol · plan"),
      "~/repos/agentj",
      "  ◐ [j1] build: Run the test suite  24s",
      "  ◐ [j2] plan: Investigate the failure  14s",
    ]);
  });
});
