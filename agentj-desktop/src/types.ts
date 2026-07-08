// Wire types — must match the Rust backend contract exactly.

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
}

export interface ToolStart {
  name: string;
  args: string;
  step: number;
}
export interface ToolEnd {
  ok: boolean;
  elapsed_ms: number;
  summary: string;
}
export interface SubagentStart {
  id: number;
  desc: string;
}
export interface SubagentProgress {
  id: number;
  status: string;
}
export interface SubagentEnd {
  id: number;
  ok: boolean;
  summary: string;
  elapsed_ms: number;
}
export interface SubagentUsage {
  id: number;
  usage: Usage;
}
export interface ArtifactMeta {
  name: string;
  format: "markdown" | "html" | string;
}

// Adjacently-tagged agent events: { kind, data? }.
export type AgentEvent =
  | { kind: "message"; data: string }
  | { kind: "thinking"; data: string }
  | { kind: "tool_start"; data: ToolStart }
  | { kind: "tool_end"; data: ToolEnd }
  | { kind: "subagent_start"; data: SubagentStart }
  | { kind: "subagent_progress"; data: SubagentProgress }
  | { kind: "subagent_end"; data: SubagentEnd }
  | { kind: "usage"; data: Usage }
  | { kind: "subagent_usage"; data: SubagentUsage }
  | { kind: "artifact"; data: ArtifactMeta }
  | { kind: "note"; data: string }
  | { kind: "step_limit"; data: number }
  | { kind: "error"; data: string }
  | { kind: "done" };

export interface Blueprint {
  name: string;
  html: string;
}

// --- tool & MCP status (invoke("tool_status", { sessionId })) --------------
export interface McpServerStatus {
  name: string;
  state: "ok" | "needs_auth" | "error";
  tools: number;
  detail: string | null;
}
export interface ToolStatus {
  builtins: { name: string; description: string }[];
  mcp: McpServerStatus[];
  mcpToolCount: number;
}

// One open session, keyed by `id`. `root` is the checkout in use (a worktree or
// the base checkout); `base` is the main repository directory the worktree hangs
// off; `projectName` is the display name of that base repository.
export interface SessionMeta {
  id: string;
  root: string;
  branch: string | null;
  base: string;
  projectName: string;
  isWorktree: boolean;
}

// Backend event payloads are tagged with the session they belong to.
export interface AgentEventEnvelope {
  sessionId: string;
  event: AgentEvent;
}
export interface BlueprintEvent {
  sessionId: string;
  name: string;
  html: string;
}

// One selectable checkout under a repo: the base checkout or an agentj worktree.
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
  isActive: boolean;
}

// Result of inspecting a picked directory. `base` is the main repo dir,
// `baseName` its display name, `defaultBranch` the origin default to branch off.
export interface RepoScan {
  isGit: boolean;
  base: string;
  baseName: string;
  defaultBranch: string;
  worktrees: WorktreeEntry[];
}

// A locally-injected event for user prompts, kept in the same stream so
// ordering against agent events is preserved.
export type UserEvent = { kind: "user"; data: string };
export type StreamEvent = AgentEvent | UserEvent;

// --- Derived transcript blocks --------------------------------------------

export type ToolPrefix = "·" | "+" | "✗";

export interface ToolLine {
  prefix: ToolPrefix;
  name: string;
  args: string;
  elapsed_ms: number | null;
  summary: string;
  ok: boolean;
  pending: boolean;
}

export interface Subagent {
  id: number;
  desc: string;
  status: string;
  ok: boolean | null;
  elapsed_ms: number | null;
  summary: string;
  tokens: number | null;
  done: boolean;
}

export interface Wave {
  n: number;
  subagents: Subagent[];
}

export type Block =
  | { type: "card"; role: "you" | "agentj"; text: string; id: string }
  | { type: "thinking"; text: string; id: string }
  | { type: "note"; text: string; id: string }
  | { type: "error"; text: string; id: string }
  | { type: "tool"; lines: ToolLine[]; id: string }
  | { type: "tray"; wave: Wave; id: string };
