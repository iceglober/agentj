import type { ChatEvent } from "../chat/events";
import type { CompletionReport } from "../report";
import { parseCompletionReport } from "../report";
import { truncateWithNotice } from "../truncation";
import { formatChatEvent } from "./chat-event-format";
import { statusLabel, validationLabel } from "./completion-report";
import { renderMarkdownLite } from "./markdown";
import { formatDuration } from "./progress";
import type { UiBlock, UiLine, UiSpan, UiTone } from "./styles";
import { formatUserTurnBlock, wrapMutedBlock } from "./transcript";

/**
 * One rendering seam for the chat transcript. A `ChatEvent` becomes a typed
 * `TranscriptItem` (via {@link toTranscriptItem}), and a single switch
 * ({@link renderTranscriptItem}) lowers each kind to the shared `UiBlock`
 * model both live-region adapters already print. Tone carries meaning here —
 * an outcome glyph, a status color — instead of coloring whole rows.
 */

const STEP_LIMIT_NOTICE =
  '(step limit reached — turn stopped mid-work; send "continue" to resume, or raise agent.steps)';
const EMPTY_RESPONSE_NOTICE = "(no response — the model returned nothing; try again)";

/** Outcome tone for a tool row. `running` is the live-region spinner state. */
export type ToolOutcome = "running" | "ok" | "fail" | "blocked";

/** One finished (or running) tool call, ready to render in either place. */
export interface ToolRow {
  tool: string;
  detail: string;
  elapsedMs?: number;
  outcome: ToolOutcome;
  /** Frozen subagent DAG lines owned by this tool, toned by leading glyph. */
  dag?: string[];
}

export interface UserTurnItem {
  kind: "user";
  text: string;
  transcriptText?: string;
}

export interface AssistantItem {
  kind: "assistant";
  body: string;
  report?: CompletionReport;
  stepLimitReached?: boolean;
}

export interface ToolItem {
  kind: "tool";
  row: ToolRow;
}

/** System-ish one-liners. `tone` colors a failed/notable line when known. */
export interface NoticeItem {
  kind: "notice" | "command" | "mode" | "dequeued" | "questions";
  text: string;
  tone?: UiTone;
}

export interface JobItem {
  kind: "job";
  text: string;
  status: "started" | "done" | "failed" | "aborted";
}

export interface ErrorItem {
  kind: "error";
  text: string;
  /** Optional muted follow-up (e.g. the content-filter guidance). */
  hint?: string;
}

export interface EmptyResponseItem {
  kind: "empty";
}

/** The agent's first-person self-reflection, shown as a dim wrapped block. */
export interface ReflectionItem {
  kind: "reflection";
  text: string;
}

export type TranscriptItem =
  | UserTurnItem
  | AssistantItem
  | ToolItem
  | NoticeItem
  | JobItem
  | ErrorItem
  | EmptyResponseItem
  | ReflectionItem;

export type RenderedItem = { block: UiBlock; spacing: "none" | "turn" };

const OUTCOME: Record<ToolOutcome, { glyph: string; tone: UiTone }> = {
  running: { glyph: "▌", tone: "accent" },
  ok: { glyph: "✓", tone: "success" },
  fail: { glyph: "✗", tone: "danger" },
  blocked: { glyph: "⊘", tone: "warning" },
};

const STATUS_TONE: Record<JobItem["status"], UiTone> = {
  started: "accent",
  done: "success",
  failed: "danger",
  aborted: "warning",
};

const REPORT_STATUS_TONE: Record<CompletionReport["status"], UiTone> = {
  done: "success",
  failed: "danger",
  blocked: "warning",
  in_progress: "accent",
};

/**
 * A completion report as a block: a tone-coded status line, then real
 * bold+underline section headers (matching `renderMarkdownLite`'s `#` headers)
 * with plain bullet lines — instead of the raw prose the old formatter produced.
 */
export const renderCompletionReportBlock = (report: CompletionReport): UiBlock => {
  const lines: UiLine[] = [
    [
      {
        text: `${statusLabel(report.status)} — ${report.summary}`,
        tone: REPORT_STATUS_TONE[report.status],
      },
    ],
  ];
  const header = (title: string): UiLine => [{ text: title, bold: true, underline: true }];
  const bullets = (items: readonly string[]): UiLine[] =>
    items.map((item) => [{ text: `- ${item}` }]);
  const section = (title: string, rows: UiLine[]): void => {
    if (rows.length === 0) return;
    lines.push([{ text: "" }], header(title), ...rows);
  };
  section("Changes", bullets(report.changes));
  section(
    "Validation",
    report.validation.map((item) => [
      { text: `- ${validationLabel(item.outcome)} — ${item.command}: ${item.evidence}` },
    ]),
  );
  section("Next", bullets(report.nextSteps));
  section("Open questions", bullets(report.openQuestions));
  return lines;
};

const flatten = (value: string): string => value.replace(/\r\n?|\n/gu, " ");

/**
 * The shared tool-row shape. `live:true` is the running spinner form for the
 * progress region; `live:false` freezes it into the transcript. Only the
 * leading glyph carries tone — the tool name is default weight and the detail
 * and duration are muted — so a busy turn reads as a calm column, not a wall
 * of color.
 */
export const renderToolRow = (row: ToolRow, opts: { live: boolean }, width: number): UiBlock => {
  const { glyph, tone } = OUTCOME[opts.live ? "running" : row.outcome];
  const spans: UiSpan[] = [
    { text: "  " },
    { text: glyph, tone },
    { text: " " },
    { text: row.tool },
  ];
  if (row.detail.trim().length > 0) {
    spans.push({
      text: `  ${truncateWithNotice(flatten(row.detail), Math.max(1, width))}`,
      tone: "muted",
    });
  }
  if (row.elapsedMs !== undefined) {
    spans.push({ text: `  ${formatDuration(row.elapsedMs)}`, tone: "muted" });
  }
  const dag = (row.dag ?? []).map(renderDagLine);
  return [spans, ...dag];
};

/**
 * Tone a frozen subagent DAG line by its leading glyph, preserving indentation.
 * A legacy `x ` failure marker is upgraded to `✗ ` on the way through.
 */
export const renderDagLine = (line: string): UiLine => {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  if (trimmed.startsWith("✓")) return [{ text: line, tone: "success" }];
  if (trimmed.startsWith("✗")) return [{ text: line, tone: "danger" }];
  if (trimmed.startsWith("x ")) return [{ text: `${indent}✗ ${trimmed.slice(2)}`, tone: "danger" }];
  if (trimmed.startsWith("·") || trimmed.startsWith("↳")) return [{ text: line, tone: "muted" }];
  return [{ text: line }];
};

/** Map a `ChatEvent` to the transcript item it renders as, or null to skip it. */
export const toTranscriptItem = (event: ChatEvent): TranscriptItem | null => {
  switch (event.type) {
    case "turn-started":
      return {
        kind: "user",
        text: event.text,
        ...(event.transcriptText !== undefined ? { transcriptText: event.transcriptText } : {}),
      };
    case "assistant": {
      const report = parseCompletionReport(event.text);
      if (report) return { kind: "assistant", body: "", report };
      const body = event.text.trim();
      if (body.length === 0 && !event.stepLimitReached) return { kind: "empty" };
      return {
        kind: "assistant",
        body,
        ...(event.stepLimitReached ? { stepLimitReached: true } : {}),
      };
    }
    case "turn-error": {
      const filtered = /content management policy|content filter|was filtered/iu.test(event.error);
      return {
        kind: "error",
        text: `error: ${event.error}`,
        ...(filtered
          ? {
              hint: "The provider's content filter rejected this request. It often fires intermittently — retry once; if it keeps happening, start a new session (aj) instead of resuming this one.",
            }
          : {}),
      };
    }
    case "turn-aborted":
      return { kind: "notice", text: "(turn interrupted)" };
    case "command":
      return { kind: "command", text: `Command: ${event.name}` };
    case "mode-changed":
      return {
        kind: "mode",
        text: event.pending ? `(mode → ${event.mode} at next turn)` : `(mode → ${event.mode})`,
      };
    case "turn-dequeued":
      return {
        kind: "dequeued",
        text: `(dequeued) ${(event.restoreText ?? event.text).split("\n")[0]?.slice(0, 60) ?? ""}`,
      };
    case "questions-answered":
      return {
        kind: "questions",
        text: event.answers
          .map(
            ({ header, answers }) =>
              `${header}: ${answers.length > 0 ? answers.join(", ") : "(none)"}`,
          )
          .join("\n"),
      };
    case "reflection":
      return { kind: "reflection", text: event.text };
    case "notice":
      return { kind: "notice", text: event.text };
    case "job-started":
      return { kind: "job", text: formatChatEvent(event) ?? "", status: "started" };
    case "job-finished":
      return {
        kind: "job",
        text: formatChatEvent(event) ?? "",
        status: event.job.status === "running" ? "started" : event.job.status,
      };
    default:
      return null;
  }
};

/** The single switch that lowers a `TranscriptItem` to a block plus spacing. */
export const renderTranscriptItem = (item: TranscriptItem, width: number): RenderedItem => {
  switch (item.kind) {
    case "user":
      return {
        block: formatUserTurnBlock(item.text, item.transcriptText, width),
        spacing: "turn",
      };
    case "assistant": {
      if (item.report) return { block: renderCompletionReportBlock(item.report), spacing: "turn" };
      const text = item.stepLimitReached
        ? `${item.body.length > 0 ? `${item.body}\n` : ""}${STEP_LIMIT_NOTICE}`
        : item.body;
      return { block: renderMarkdownLite(text), spacing: "turn" };
    }
    case "empty":
      return { block: [[{ text: EMPTY_RESPONSE_NOTICE, tone: "muted" }]], spacing: "turn" };
    case "reflection":
      return { block: wrapMutedBlock(item.text, width), spacing: "turn" };
    case "tool":
      return { block: renderToolRow(item.row, { live: false }, width), spacing: "none" };
    case "error": {
      const block: UiLine[] = [[{ text: item.text, tone: "danger" }]];
      if (item.hint) block.push([{ text: item.hint, tone: "muted" }]);
      return { block, spacing: "none" };
    }
    case "job": {
      const tone = STATUS_TONE[item.status];
      const [head, ...rest] = item.text.split("\n");
      const block: UiLine[] = [
        [{ text: head ?? "", tone }],
        ...rest.map((line) => [{ text: line }]),
      ];
      return { block, spacing: "none" };
    }
    default: {
      const tone = item.tone;
      const block: UiBlock = item.text
        .split("\n")
        .map((line): UiLine => (tone ? [{ text: line, tone }] : [{ text: line }]));
      return { block, spacing: "none" };
    }
  }
};
