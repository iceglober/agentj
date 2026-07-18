import type { PermissionRequest } from "../agent/permissions";
import type { SubagentProgressEvent } from "../agent/subagents";
import type { RunStep } from "../llm";
import type { ChatMode } from "../session/log";

type ToolCall = RunStep["toolCalls"][number];
type ToolResult = RunStep["toolResults"][number];

/** A background job as rendered to the user. */
export interface JobView {
  id: string;
  mode: ChatMode;
  prompt: string;
  status: "running" | "done" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  /** When set, `ping` fires at this time if the job is still running. */
  softTimeoutAt?: number;
  resultText?: string;
  /** Branch preserving the job's work when integration was blocked. */
  branch?: string;
}

/**
 * Everything the chat loop tells the outside world — the TUI renders these
 * and decides nothing (same contract ConversationEvent had for the old loop).
 */
export type ChatEvent =
  | { type: "turn-started"; mode: ChatMode; text: string; transcriptText?: string }
  | { type: "turn-queued"; text: string; transcriptText?: string; restoreText?: string }
  | { type: "turn-dequeued"; text: string; restoreText?: string }
  | { type: "command"; name: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; result: ToolResult }
  | { type: "turn-usage"; usage: NonNullable<RunStep["usage"]> }
  | { type: "assistant"; mode: ChatMode; text: string; stepLimitReached?: boolean }
  | { type: "turn-abort-requested" }
  | { type: "turn-aborted" }
  | { type: "turn-error"; error: string }
  | { type: "turn-finished" }
  | { type: "mode-changed"; mode: ChatMode; pending: boolean }
  | { type: "subagent-progress"; progress: SubagentProgressEvent }
  | { type: "permission-ask"; request: PermissionRequest }
  | { type: "job-started"; job: JobView }
  | { type: "job-finished"; job: JobView }
  | { type: "notice"; text: string };
