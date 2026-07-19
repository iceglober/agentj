import { describe, expect, test } from "bun:test";
import { composeThinkingLine } from "./status";

describe("composeThinkingLine", () => {
  test("renders and truncates an active thinking line", () => {
    const state = {
      thinking: true,
      interruptRequested: false,
      spinnerFrame: 0,
      turnStartedAt: 62_000,
      now: 74_000,
    };

    expect(composeThinkingLine(state, 80)).toBe("◐ thinking 12s (esc)");
    expect(composeThinkingLine(state, 12)).toBe("[trunc 20 chars]");
  });
});
