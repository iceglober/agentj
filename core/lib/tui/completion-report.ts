import { type CompletionReport, parseCompletionReport } from "../report";

const statusLabel = (status: CompletionReport["status"]): string =>
  ({ done: "Done", in_progress: "In progress", blocked: "Blocked", failed: "Failed" })[status];

const validationLabel = (outcome: CompletionReport["validation"][number]["outcome"]): string =>
  ({ passed: "Passed", failed: "Failed", not_run: "Not run" })[outcome];

/** Present the complete structured result in the transcript rather than dropping
 * evidence and next steps behind a one-line summary. */
export const formatCompletionReport = (report: CompletionReport): string => {
  const sections = [`${statusLabel(report.status)} — ${report.summary}`];
  if (report.changes.length > 0)
    sections.push(`Changes:\n${report.changes.map((change) => `- ${change}`).join("\n")}`);
  if (report.validation.length > 0) {
    sections.push(
      `Validation:\n${report.validation.map((item) => `- ${validationLabel(item.outcome)} — ${item.command}: ${item.evidence}`).join("\n")}`,
    );
  }
  if (report.nextSteps.length > 0)
    sections.push(`Next:\n${report.nextSteps.map((step) => `- ${step}`).join("\n")}`);
  if (report.openQuestions.length > 0)
    sections.push(
      `Open questions:\n${report.openQuestions.map((question) => `- ${question}`).join("\n")}`,
    );
  return sections.join("\n\n");
};

/** Returns formatted transcript text only when text is a valid completion report. */
export const formatCompletionReportText = (text: string): string | null => {
  const report = parseCompletionReport(text);
  return report ? formatCompletionReport(report) : null;
};
