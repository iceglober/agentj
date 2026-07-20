import z from "zod";

export const completionReportSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string(),
  changes: z.array(z.string()),
  validation: z.array(
    z.object({
      command: z.string(),
      outcome: z.enum(["passed", "blocked"]),
      evidence: z.string(),
    }),
  ),
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
{"status":"done|blocked|failed","summary":"...","changes":["..."],"validation":[{"command":"exact command run","outcome":"passed|blocked","evidence":"..."}],"openQuestions":["..."]}
Use status=done only when every claimed passing validation command was actually
run and succeeded.`;
