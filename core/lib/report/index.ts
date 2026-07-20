import z from "zod";

const validationOutcomeSchema = z
  .enum(["passed", "failed", "not_run", "blocked"])
  .transform((outcome) => (outcome === "blocked" ? "not_run" : outcome));

export const completionReportSchema = z.object({
  status: z.enum(["done", "in_progress", "blocked", "failed"]),
  summary: z.string(),
  changes: z.array(z.string()),
  validation: z.array(
    z.object({
      command: z.string(),
      outcome: validationOutcomeSchema,
      evidence: z.string(),
    }),
  ),
  nextSteps: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()),
});

export type CompletionReport = z.infer<typeof completionReportSchema>;

/** Parse the agent's deliberately machine-readable final response. */
export const parseCompletionReport = (text: string): CompletionReport | null => {
  try {
    return completionReportSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
};

export const COMPLETION_REPORT_INSTRUCTION = `# Completion report
Your final response must be JSON only:
{"status":"done|in_progress|blocked|failed","summary":"...","changes":["..."],"validation":[{"command":"exact command run","outcome":"passed|failed|not_run","evidence":"..."}],"nextSteps":["..."],"openQuestions":["..."]}
Use status=in_progress only after run_job returns a job ID; put that job ID and what it will do in nextSteps.
Use status=done only when every claimed passing validation command was actually
run and succeeded.`;
