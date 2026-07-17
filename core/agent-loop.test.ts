import { describe, expect, test } from "bun:test";
import { formatChatEvent, truncateLineWithNotice } from "./agent-loop";

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
