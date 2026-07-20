import { type CompletionReport, parseCompletionReport } from "../report";

const statusMarker = (status: CompletionReport["status"]): string =>
  status === "done" ? "✓" : status === "failed" ? "x" : "!";

/** Present the complete structured result in the transcript rather than dropping
 * evidence and open questions behind a one-line summary. */
export const formatCompletionReport = (report: CompletionReport): string => {
  const sections = [`${statusMarker(report.status)} ${report.summary}`];
  if (report.changes.length > 0)
    sections.push(`Changes:\n${report.changes.map((change) => `- ${change}`).join("\n")}`);
  if (report.validation.length > 0) {
    sections.push(
      `Validation:\n${report.validation.map((item) => `- ${item.outcome === "passed" ? "✓" : "!"} ${item.command}: ${item.evidence}`).join("\n")}`,
    );
  }
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
