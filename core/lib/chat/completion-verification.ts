import type { RunResult, RunStep } from "../llm";
import { parseCompletionReport } from "../report";

const successfulBashCommands = (steps: readonly RunStep[]): string[] =>
  steps
    .flatMap((step) => {
      const calls = step.toolCalls.filter((call) => call.name === "bash");
      const results = step.toolResults.filter((result) => result.name === "bash");
      return calls.flatMap((call, index) =>
        results[index]?.isError === false || results[index]?.isError === undefined
          ? [
              typeof call.input === "object" && call.input !== null && "command" in call.input
                ? (call.input as { command: unknown }).command
                : undefined,
            ]
          : [],
      );
    })
    .filter((command): command is string => typeof command === "string");

/**
 * Verify a build completion against the vendor-neutral trajectory the runtime
 * observed. Returns a user-safe reason when the model's claimed success must
 * be retried or rejected.
 */
export const verifyBuildCompletion = (result: Pick<RunResult, "text" | "steps">): string | null => {
  const report = parseCompletionReport(result.text);
  if (!report) return "the response was not a valid completion report";
  if (report.status !== "done") return null;

  if (result.steps.every((step) => step.toolCalls.length === 0)) {
    return "the report claimed done without any observed tool calls";
  }
  if (report.validation.length === 0) {
    return "the report claimed done without validation";
  }

  const passed = report.validation.filter((validation) => validation.outcome === "passed");
  if (passed.length === 0) {
    return "the report claimed done without a passed validation command";
  }

  const commands = new Set(successfulBashCommands(result.steps));
  const unobserved = passed.find((validation) => !commands.has(validation.command));
  return unobserved
    ? `the passed validation command was not an observed successful bash call: ${unobserved.command}`
    : null;
};

export const completionVerificationFailure = (reason: string): string =>
  JSON.stringify({
    status: "failed",
    summary: `AgentJ rejected the completion report: ${reason}.`,
    changes: [],
    validation: [],
    openQuestions: ["Retry the task after inspecting the reported verification failure."],
  });
