import { describe, expect, test } from "bun:test";
import { formatCompletionReportText } from "./completion-report";

describe("formatCompletionReportText", () => {
  test("renders every structured report field with explicit states", () => {
    expect(
      formatCompletionReportText(
        JSON.stringify({
          status: "in_progress",
          summary: "CI is running.",
          changes: ["Added completion"],
          validation: [
            { command: "bun test core", outcome: "passed", evidence: "42 tests" },
            { command: "bun run check", outcome: "not_run", evidence: "CI has not finished" },
          ],
          nextSteps: ["Job j2 will merge after CI passes."],
          openQuestions: [],
        }),
      ),
    ).toBe(
      "In progress — CI is running.\n\nChanges:\n- Added completion\n\nValidation:\n- Passed — bun test core: 42 tests\n- Not run — bun run check: CI has not finished\n\nNext:\n- Job j2 will merge after CI passes.",
    );
  });

  test("accepts legacy blocked validation reports and presents them as not run", () => {
    expect(
      formatCompletionReportText(
        JSON.stringify({
          status: "blocked",
          summary: "Dependencies are absent.",
          changes: [],
          validation: [{ command: "bun test core", outcome: "blocked", evidence: "zod missing" }],
          openQuestions: ["May I install dependencies?"],
        }),
      ),
    ).toContain("Not run — bun test core: zod missing");
  });

  test("leaves malformed or ordinary assistant text to the normal formatter", () => {
    expect(formatCompletionReportText("implemented\nwith details")).toBeNull();
    expect(formatCompletionReportText('{"summary":"missing fields"}')).toBeNull();
  });
});
