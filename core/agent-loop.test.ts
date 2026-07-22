import { describe, expect, test } from "bun:test";
import {
  finalizeInteractiveChat,
  formatChatEvent,
  formatResumeCommand,
  notifyAvailableUpdate,
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
        body: "Use run_background_job.",
        userInvocable: false,
        metadata: {},
      },
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "ship", mode: "build" });
  });
});

describe("update notices", () => {
  test("emits a notice for an available update", async () => {
    const events: unknown[] = [];
    await notifyAvailableUpdate(
      async () => ({ available: "0.1.0-next.44" }),
      (event) => events.push(event),
    );
    expect(events).toEqual([
      {
        type: "notice",
        text: "agentj 0.1.0-next.44 is available. Run /update to install it.",
      },
    ]);
  });

  test("stays silent for current versions and failed checks", async () => {
    const events: unknown[] = [];
    await notifyAvailableUpdate(
      async () => undefined,
      (event) => events.push(event),
    );
    await notifyAvailableUpdate(
      async () => Promise.reject(new Error("registry unavailable")),
      (event) => events.push(event),
    );
    expect(events).toEqual([]);
  });

  test("can suppress a late result after teardown", async () => {
    let resolveCheck: ((value: { available: string }) => void) | undefined;
    const events: unknown[] = [];
    let active = true;
    const pending = notifyAvailableUpdate(
      () => new Promise((resolve) => (resolveCheck = resolve)),
      (event) => {
        if (active) events.push(event);
      },
    );
    active = false;
    resolveCheck?.({ available: "0.1.0-next.44" });
    await pending;
    expect(events).toEqual([]);
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

  test("renders structured question answers in the transcript", () => {
    expect(
      formatChatEvent({
        type: "questions-answered",
        answers: [
          { header: "Scope", question: "What should change?", answers: ["CLI", "TUI"] },
          { header: "Tests", question: "Which tests?", answers: [] },
        ],
      }),
    ).toBe("Scope: CLI, TUI\nTests: (none)");
  });

  test("keeps turn lifecycle-only events out of the transcript", () => {
    expect(formatChatEvent({ type: "turn-abort-requested" })).toBeNull();
    expect(formatChatEvent({ type: "turn-finished" })).toBeNull();
    expect(formatChatEvent({ type: "submission-finished" })).toBeNull();
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
          nextSteps: [],
          openQuestions: ["None"],
        }),
      }),
    ).toBe(
      "Done — plan ready\n\nChanges:\n- Scanned editor tokens\n\nValidation:\n- Passed — bun test core: green\n\nOpen questions:\n- None",
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
    ).toBe("[j2] Finished in 1m14s — monitor the release workflow\nPackage published.");
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
            nextSteps: [],
            openQuestions: [],
          },
        },
      }),
    ).toBe(
      "[j2] Finished in 1s — monitor the release workflow\nDone — Package published.\n\nChanges:\n- Merged PR #124\n\nValidation:\n- Passed — gh pr checks 124: green",
    );
  });

  test("formats executor JSON job results without exposing JSON", () => {
    const result = JSON.stringify({
      status: "SUCCESS",
      changes: [{ type: "merge", pr: 149, command: "gh pr merge 149 --squash --auto" }],
      evidence: [
        {
          command: "gh pr checks 149 --watch",
          exitCode: 0,
          stdout: "core-tests\tpass\neval-selftest\tpass",
        },
      ],
      open_questions: [],
    });
    const rendered = formatChatEvent({
      type: "job-finished",
      job: {
        id: "j2",
        mode: "build",
        prompt: "monitor the release workflow",
        status: "done",
        startedAt: 0,
        endedAt: 1_000,
        resultText: result,
      },
    });
    expect(rendered).toContain("SUCCESS");
    expect(rendered).toContain("Changes:\n- Type: merge\n  Pr: 149");
    expect(rendered).toContain("Evidence:\n- Command: gh pr checks 149 --watch");
    expect(rendered).toContain("  Stdout:\n    core-tests\tpass\n    eval-selftest\tpass");
    expect(rendered).not.toContain('"status"');
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
    ).toBe("[j2] Failed in 1s — monitor the release workflow\nChild worktree setup failed.");
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
