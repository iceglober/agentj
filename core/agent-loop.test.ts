import { describe, expect, test } from "bun:test";
import {
  createUpdateRestartOptions,
  finalizeInteractiveChat,
  formatActivityReceipt,
  formatChatEvent,
  formatResumeCommand,
  shouldWarnContext,
  toSkillCommands,
  truncateLineWithNotice,
} from "./agent-loop";

describe("skill command catalog", () => {
  test("excludes model-only skills from slash-command routing", () => {
    const commands = toSkillCommands([
      {
        name: "ship",
        description: "Ship finished work.",
        path: "/repo/.aj/skills/ship/SKILL.md",
        dir: "/repo/.aj/skills/ship",
        body: "Ship it.",
        userInvocable: true,
        metadata: { "agentj-mode": "build" },
      },
      {
        name: "running-background-work",
        description: "Continue work after this turn.",
        path: "/repo/.aj/skills/running-background-work/SKILL.md",
        dir: "/repo/.aj/skills/running-background-work",
        body: "Use run_job.",
        userInvocable: false,
        metadata: {},
      },
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "ship", mode: "build" });
  });
});

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

describe("formatActivityReceipt", () => {
  test("summarizes completed tools and points to activity details", () => {
    expect(formatActivityReceipt(1, 1_200)).toBe("✓ 1 tool · 1.2s · /activity for details");
    expect(formatActivityReceipt(3, 74_000)).toBe("✓ 3 tools · 74.0s · /activity for details");
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

  test("formats structured job completions without exposing JSON", () => {
    expect(
      formatChatEvent({
        type: "job-finished",
        job: {
          id: "j2",
          mode: "build",
          prompt: "monitor the release workflow",
          status: "done",
          startedAt: 0,
          endedAt: 1_000,
          resultText: "Package published.",
          completion: {
            status: "done",
            summary: "Package published.",
            changes: ["Merged PR #124"],
            validation: [{ command: "gh pr checks 124", outcome: "passed", evidence: "green" }],
            openQuestions: [],
          },
        },
      }),
    ).toBe(
      "✓ [j2] done in 1s — monitor the release workflow\n✓ Package published.\n\nChanges:\n- Merged PR #124\n\nValidation:\n- ✓ gh pr checks 124: green",
    );
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

describe("shouldWarnContext", () => {
  test("fires at the threshold and re-arms after meaningful context growth", () => {
    expect(shouldWarnContext(239_999, 240_000, undefined)).toBe(false);
    expect(shouldWarnContext(240_000, 240_000, undefined)).toBe(true);
    expect(shouldWarnContext(263_999, 240_000, 240_000)).toBe(false);
    expect(shouldWarnContext(264_000, 240_000, 240_000)).toBe(true);
    expect(shouldWarnContext(300_000, undefined, undefined)).toBe(false);
  });
});
