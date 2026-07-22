import type { ChatEvent } from "../chat/events";
import { truncateWithNotice } from "../truncation";
import {
  formatCompletionReport,
  formatCompletionReportText,
  formatExecutorResultText,
} from "./completion-report";
import { formatClock } from "./status";
import type { UiTextLine } from "./styles";

/** Keep a bounded single-line preview while making the omitted character count explicit. */
export const truncateLineWithNotice = (value: string, maxLength: number): string =>
  truncateWithNotice(value.replace(/\r\n?|\n/gu, " "), maxLength);

/** Render a ChatEvent as transcript text. */
export const formatChatEvent = (event: ChatEvent): string | null => {
  switch (event.type) {
    case "turn-started":
      return event.transcriptText ?? `> ${event.text}`;
    case "turn-queued":
      return null;
    case "turn-dequeued":
      return `(dequeued) ${(event.restoreText ?? event.text).split("\n")[0]?.slice(0, 60) ?? ""}`;
    case "command":
      return `Command: ${event.name}`;
    case "tool-call":
      return null;
    case "assistant": {
      const completion = formatCompletionReportText(event.text);
      if (completion) return completion;
      const body = event.text.trim();
      if (event.stepLimitReached)
        return `${body.length > 0 ? `${body}\n` : ""}(step limit reached — turn stopped mid-work; send "continue" to resume, or raise agent.steps)`;
      return body.length > 0 ? body : null;
    }
    case "turn-aborted":
      return "(turn interrupted)";
    case "turn-error":
      return `error: ${event.error}`;
    case "questions-answered":
      return event.answers
        .map(
          ({ header, answers }) =>
            `${header}: ${answers.length > 0 ? answers.join(", ") : "(none)"}`,
        )
        .join("\n");
    case "mode-changed":
      return event.pending ? `(mode → ${event.mode} at next turn)` : `(mode → ${event.mode})`;
    case "job-started":
      return `[${event.job.id}] started (${event.job.mode}): ${event.job.prompt.slice(0, 60)}`;
    case "job-finished": {
      const elapsed = formatClock((event.job.endedAt ?? Date.now()) - event.job.startedAt);
      const result = event.job.resultText?.trim();
      const branch = event.job.branch ? `\nwork preserved on ${event.job.branch}` : "";
      const status =
        event.job.status === "done"
          ? "Finished"
          : event.job.status === "failed"
            ? "Failed"
            : "Aborted";
      const completion = event.job.completion
        ? `\n${formatCompletionReport(event.job.completion)}`
        : result
          ? `\n${truncateWithNotice(formatExecutorResultText(result) ?? result, 2_000)}`
          : "";
      return `[${event.job.id}] ${status} in ${elapsed} — ${event.job.prompt.slice(0, 60)}${completion}${branch}`;
    }
    case "notice":
      return event.text;
    default:
      return null;
  }
};

/** Keep activity state legible in monochrome while giving active outcomes a semantic tone. */
export const presentActivityLine = (text: string): UiTextLine => {
  const trimmed = text.trimStart();
  const tone =
    trimmed.startsWith("✓") || trimmed.startsWith("Done") || trimmed.includes("] Finished")
      ? "success"
      : trimmed.startsWith("x") ||
          trimmed.startsWith("✗") ||
          trimmed.startsWith("Failed") ||
          trimmed.includes("] Failed")
        ? "danger"
        : trimmed.startsWith("!") || trimmed.startsWith("Blocked") || trimmed.includes("] Aborted")
          ? "warning"
          : trimmed.startsWith("↳ queued")
            ? "warning"
            : trimmed.startsWith("In progress") ||
                trimmed.startsWith("◐") ||
                trimmed.startsWith("◓") ||
                trimmed.startsWith("◑") ||
                trimmed.startsWith("◒")
              ? "accent"
              : trimmed.startsWith("·")
                ? "muted"
                : undefined;
  return tone ? [{ text, tone }] : text;
};
