import { describe, expect, test } from "bun:test";
import { formatCompletionReportText } from "./completion-report";

describe("formatCompletionReportText", () => {
  test("renders every structured report field", () => {
    expect(
      formatCompletionReportText(
        JSON.stringify({
          status: "done",
          summary: "implemented",
          changes: ["Added completion"],
          validation: [{ command: "bun test core", outcome: "passed", evidence: "42 tests" }],
          openQuestions: ["None"],
        }),
      ),
    ).toBe(
      "✓ implemented\n\nChanges:\n- Added completion\n\nValidation:\n- ✓ bun test core: 42 tests\n\nOpen questions:\n- None",
    );
  });

  test("leaves malformed or ordinary assistant text to the normal formatter", () => {
    expect(formatCompletionReportText("implemented\nwith details")).toBeNull();
    expect(formatCompletionReportText('{"summary":"missing fields"}')).toBeNull();
  });
});
