import type { PermissionRequest } from "../agent/permissions";
import type { SubagentProgressEvent } from "../agent/subagents";
import type { RunStep } from "../llm";
import type { ChatMode } from "../session/log";
import type { TodoList } from "../todos";

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
  /** Branch preserving work or cleanup state for recovery. */
  branch?: string;
  /** Non-fatal cleanup issues after job work completed. */
  warnings?: string[];
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
  /** The session continuation and durable visible history were reset. */
  | { type: "context-cleared" }
  | { type: "todos-updated"; items: TodoList }
  | { type: "mode-changed"; mode: ChatMode; pending: boolean }
  | { type: "subagent-progress"; progress: SubagentProgressEvent }
  | { type: "permission-ask"; request: PermissionRequest }
  | { type: "job-started"; job: JobView }
  | { type: "job-finished"; job: JobView }
  | { type: "notice"; text: string };
