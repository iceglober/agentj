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
  result: string;
}
export interface SubagentStart {
  id: number;
  desc: string;
  agent_type: string;
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
}
// One option of an ask_user question; the recommended option is listed first by convention.
export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multi_select: boolean;
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
  | { kind: "ask_user"; data: { questions: AskQuestion[] } }
  | { kind: "note"; data: string }
  | { kind: "step_limit"; data: number }
  | { kind: "error"; data: string }
  | { kind: "done" };

// An in-app "view" tab: a URL (e.g. a locally-running dev server) opened from a transcript link,
// shown in an iframe so it never hijacks the agentj window. `id` is the url (dedupes tabs).
export interface OpenView {
  id: string;
  url: string;
  title: string;
}

// One entry in the file explorer. `rel` is the repo-relative path from the
// worktree root; the backend sorts dirs-first and skips .git/node_modules/etc.
export interface FileEntry {
  name: string;
  rel: string;
  isDir: boolean;
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
  /** The active model id for this session (may differ from the global default). */
  model: string;
  /** A one-off message to show first in the transcript (e.g. a provisioning fallback). */
  notice: string | null;
}

// --- project configuration (invoke("config_files") etc.) --------------------
export interface ConfigFile {
  path: string; // repo-relative, from the backend's fixed allowlist
  label: string;
  exists: boolean;
  content: string;
}
// One hook point from the harness catalog (invoke("hooks_catalog")). `kind` is the id the
// write/delete/run commands take — the UI never touches a file path.
export interface HookInfo {
  kind: string;
  description: string;
  exists: boolean;
  content: string;
}
export interface HookRunLite {
  ok: boolean;
  summary: string;
}

// --- model selection -------------------------------------------------------
export interface ProviderInfo {
  provider: string; // "azure" | "custom"
  baseUrl: string;
  model: string;
  apiVersion: string;
  hasKey: boolean;
}
export interface ModelSettings {
  defaultProvider: string;
  defaultModel: string;
  providers: ProviderInfo[];
}
export interface ModelChoice {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiVersion?: string;
}

// Backend event payloads are tagged with the session they belong to.
export interface AgentEventEnvelope {
  sessionId: string;
  event: AgentEvent;
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
// A locally-injected system notice (e.g. a provisioning fallback), shown first in the transcript.
export type NoticeEvent = { kind: "notice"; data: string };
export type StreamEvent = AgentEvent | UserEvent | NoticeEvent;

// --- Derived transcript blocks --------------------------------------------

export type ToolPrefix = "·" | "+" | "✗";

export interface ToolLine {
  prefix: ToolPrefix;
  name: string;
  args: string;
  elapsed_ms: number | null;
  summary: string;
  result: string;
  ok: boolean;
  pending: boolean;
}

export type Block =
  | { type: "card"; role: "you" | "agentj"; text: string; id: string }
  // Structured questions from ask_user — the turn ended right after; options are clickable.
  | { type: "questions"; questions: AskQuestion[]; id: string }
  | { type: "thinking"; text: string; id: string }
  | { type: "note"; text: string; id: string }
  | { type: "notice"; text: string; id: string }
  | { type: "error"; text: string; id: string }
  | { type: "tool"; lines: ToolLine[]; id: string }
  // One subagent launched by run_subagents, shown as `task[type]: title` with live status.
  | {
      type: "task";
      agentType: string;
      title: string;
      state: "running" | "ok" | "fail";
      elapsed_ms: number | null;
      summary: string;
      id: string;
    };
