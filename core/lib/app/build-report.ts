import z from "zod";
import type { RunResult, RunStep } from "../llm";

type ToolCall = RunStep["toolCalls"][number];
type ToolResult = RunStep["toolResults"][number];

export const buildReportSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().min(1),
  changes: z.array(z.string()),
  validation: z.array(
    z.object({
      command: z.string().min(1),
      outcome: z.enum(["passed", "blocked"]),
      evidence: z.string().min(1),
    }),
  ),
  openQuestions: z.array(z.string()),
});

export type BuildReport = z.infer<typeof buildReportSchema>;

export type BuildAssessment =
  | { ok: true; report: BuildReport; result: RunResult }
  | { ok: false; reason: string; report?: BuildReport };

const unwrapJson = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1] ?? trimmed;
};

const commandFromCall = (call: ToolCall): string | null => {
  if (call.name !== "bash" || typeof call.input !== "object" || call.input === null) return null;
  const command = (call.input as Record<string, unknown>).command;
  return typeof command === "string" ? command.trim() : null;
};

export function assessBuildResult(
  result: RunResult,
  toolCalls: readonly ToolCall[],
  toolResults: readonly ToolResult[],
): BuildAssessment {
  if (result.text.trim() === "") {
    return {
      ok: false,
      reason: result.stepLimitReached
        ? "builder reached the tool-step limit before reporting completion"
        : "builder returned an empty result",
    };
  }

  let report: BuildReport;
  try {
    report = buildReportSchema.parse(JSON.parse(unwrapJson(result.text)));
  } catch {
    return { ok: false, reason: "builder returned an invalid completion report" };
  }

  if (report.status !== "done") {
    return { ok: false, reason: report.summary, report };
  }
  const passed = report.validation.filter((entry) => entry.outcome === "passed");
  if (passed.length === 0) {
    return { ok: false, reason: "builder reported no passing validation", report };
  }
  const observedCommands = new Map<string, boolean>();
  toolCalls.forEach((call, index) => {
    const command = commandFromCall(call);
    if (command) {
      const succeeded = toolResults[index]?.isError !== true;
      observedCommands.set(command, observedCommands.get(command) === true || succeeded);
    }
  });
  const unobserved = passed.find((entry) => !observedCommands.has(entry.command.trim()));
  if (unobserved) {
    return {
      ok: false,
      reason: `validation command was not observed: ${unobserved.command}`,
      report,
    };
  }
  const failed = passed.find((entry) => observedCommands.get(entry.command.trim()) !== true);
  if (failed) {
    return { ok: false, reason: `validation command failed: ${failed.command}`, report };
  }

  return {
    ok: true,
    report,
    result: { ...result, text: report.summary },
  };
}
