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
  resultText?: string;
  /** Branch preserving the job's work when integration was blocked. */
  branch?: string;
}

/**
 * Everything the chat loop tells the outside world — the TUI renders these
 * and decides nothing (same contract ConversationEvent had for the old loop).
 */
export type ChatEvent =
  | { type: "turn-started"; mode: ChatMode; text: string }
  | { type: "turn-queued"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; result: ToolResult }
  | { type: "assistant"; mode: ChatMode; text: string; stepLimitReached?: boolean }
  | { type: "turn-aborted" }
  | { type: "turn-error"; error: string }
  | { type: "mode-changed"; mode: ChatMode; pending: boolean }
  | { type: "subagent-progress"; progress: SubagentProgressEvent }
  | { type: "permission-ask"; request: PermissionRequest }
  | { type: "job-started"; job: JobView }
  | { type: "job-finished"; job: JobView }
  | { type: "notice"; text: string };
