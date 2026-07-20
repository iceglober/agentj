import { describe, expect, test } from "bun:test";
import type { RunResult } from "../llm";
import { verifyBuildCompletion } from "./completion-verification";

const done = (
  validation: unknown[] = [{ command: "bun test core", outcome: "passed", evidence: "ok" }],
) =>
  JSON.stringify({
    status: "done",
    summary: "done",
    changes: ["changed"],
    validation,
    openQuestions: [],
  });

const result = (over: Partial<RunResult> = {}): RunResult => ({
  text: done(),
  steps: [
    {
      toolCalls: [{ name: "bash", input: { command: "bun test core" } }],
      toolResults: [{ name: "bash", output: { exitCode: 0 }, isError: false }],
    },
  ],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ...over,
});

describe("verifyBuildCompletion", () => {
  test("accepts a done report backed by a successful matching bash call", () => {
    expect(verifyBuildCompletion(result())).toBeNull();
  });

  test("rejects a done report with no observed tool calls", () => {
    expect(verifyBuildCompletion(result({ steps: [] }))).toContain(
      "without any observed tool calls",
    );
  });

  test("rejects missing or unobserved validation", () => {
    expect(verifyBuildCompletion(result({ text: done([]) }))).toContain("without validation");
    expect(
      verifyBuildCompletion(
        result({ text: done([{ command: "bun run check", outcome: "passed", evidence: "ok" }]) }),
      ),
    ).toContain("not an observed successful bash call");
  });

  test("permits normal blocked and failed reports without forcing tool evidence", () => {
    for (const status of ["blocked", "failed"]) {
      expect(
        verifyBuildCompletion(
          result({
            text: JSON.stringify({
              status,
              summary: status,
              changes: [],
              validation: [],
              openQuestions: [],
            }),
          }),
        ),
      ).toBeNull();
    }
  });

  test("rejects non-report output in build mode", () => {
    expect(verifyBuildCompletion(result({ text: "implemented" }))).toContain(
      "valid completion report",
    );
  });
});
