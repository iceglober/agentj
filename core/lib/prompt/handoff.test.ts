import { describe, expect, test } from "bun:test";
import { buildHandoffPrompt } from "./handoff";

describe("buildHandoffPrompt", () => {
  test("wraps the task and plan and tells the builder to verify, not anchor", () => {
    const seed = buildHandoffPrompt("fix the bug", "1. edit foo\n2. test");
    expect(seed).toContain("<task>\nfix the bug\n</task>");
    expect(seed).toContain("<approved-plan>\n1. edit foo\n2. test\n</approved-plan>");
    expect(seed).toContain("verify each step against the repository");
    expect(seed).not.toContain("Additional feedback");
  });

  test("appends user feedback when present", () => {
    expect(buildHandoffPrompt("t", "p", "  skip the refactor  ")).toContain(
      "Additional feedback from the user: skip the refactor",
    );
  });

  test("omits empty task/plan/feedback sections", () => {
    const seed = buildHandoffPrompt(null, null, "");
    expect(seed).not.toContain("<task>");
    expect(seed).not.toContain("<approved-plan>");
    expect(seed).not.toContain("Additional feedback");
    expect(seed).toContain("Implement the approved plan");
  });
});
