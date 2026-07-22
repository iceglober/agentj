import {
  type CompletionReport,
  type ExecutorResult,
  parseCompletionReport,
  parseExecutorResult,
} from "../report";

export const statusLabel = (status: CompletionReport["status"]): string =>
  ({ done: "Done", in_progress: "In progress", blocked: "Blocked", failed: "Failed" })[status];

export const validationLabel = (
  outcome: CompletionReport["validation"][number]["outcome"],
): string => ({ passed: "Passed", failed: "Failed", not_run: "Not run" })[outcome];

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

const formatValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const formatObjectList = (items: ReadonlyArray<Record<string, unknown>>): string =>
  items
    .map((item) =>
      Object.entries(item)
        .map(([key, value], index) => {
          const label = `${key[0]?.toUpperCase() ?? ""}${key
            .slice(1)
            .replaceAll("_", " ")
            .replace(/([a-z])([A-Z])/gu, "$1 $2")}`;
          const prefix = index === 0 ? "- " : "  ";
          const rendered = formatValue(value);
          if (!rendered.includes("\n")) return `${prefix}${label}: ${rendered}`;
          return `${prefix}${label}:\n${rendered
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")}`;
        })
        .join("\n"),
    )
    .join("\n");

/** Present the executor's structured background-job result as readable text. */
export const formatExecutorResult = (result: ExecutorResult): string => {
  const sections = [`${result.status[0]?.toUpperCase() ?? ""}${result.status.slice(1)}`];
  if (result.changes.length > 0) sections.push(`Changes:\n${formatObjectList(result.changes)}`);
  if (result.evidence.length > 0) sections.push(`Evidence:\n${formatObjectList(result.evidence)}`);
  if (result.open_questions.length > 0)
    sections.push(
      `Open questions:\n${result.open_questions.map((item) => `- ${item}`).join("\n")}`,
    );
  return sections.join("\n\n");
};

/** Returns formatted transcript text only when text is a valid completion report. */
export const formatCompletionReportText = (text: string): string | null => {
  const report = parseCompletionReport(text);
  return report ? formatCompletionReport(report) : null;
};

/** Returns formatted transcript text only when text is a valid executor result. */
export const formatExecutorResultText = (text: string): string | null => {
  const result = parseExecutorResult(text);
  return result ? formatExecutorResult(result) : null;
};
