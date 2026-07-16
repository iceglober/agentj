import { describe, expect, test } from "bun:test";
import type { RunResult } from "../llm";
import { assessBuildResult } from "./build-report";

const result = (text: string): RunResult => ({
  text,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

const validReport = JSON.stringify({
  status: "done",
  summary: "Implemented the change.",
  changes: ["src/index.ts"],
  validation: [{ command: "bun test", outcome: "passed", evidence: "12 tests passed" }],
  openQuestions: [],
});

describe("assessBuildResult", () => {
  test("accepts a done report backed by an observed validation command", () => {
    expect(
      assessBuildResult(
        result(validReport),
        [{ name: "bash", input: { command: "bun test" } }],
        [{ name: "bash", output: { exitCode: 0 } }],
      ),
    ).toMatchObject({ ok: true, result: { text: "Implemented the change." } });
  });

  test("rejects empty, malformed, unvalidated, and failed-tool completions", () => {
    expect(assessBuildResult(result(""), [], [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("empty"),
    });
    expect(assessBuildResult(result("done"), [], [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("invalid"),
    });
    expect(assessBuildResult(result(validReport), [], [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not observed"),
    });
    expect(
      assessBuildResult(
        result(validReport),
        [{ name: "bash", input: { command: "bun test" } }],
        [{ name: "bash", output: "ERROR: failed", isError: true }],
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("validation command failed") });
  });
});
