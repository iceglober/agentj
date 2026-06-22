// Client <-> server protocol: the HTTP/SSE contract between the host TUI and the
// sandboxed agent server. Mirrors docs/PLAN.md and the design doc's event taxonomy.

/** HTTP routes the agent server exposes (Bun.serve). */
export const Routes = {
  health: "/health",
  createSession: "/session",
  events: (id: string) => `/session/${id}/events`,
  message: (id: string) => `/session/${id}/message`,
  permission: (id: string, pid: string) => `/session/${id}/permission/${pid}`,
  interrupt: (id: string) => `/session/${id}/interrupt`,
  session: (id: string) => `/session/${id}`,
} as const;

/** Server → client SSE events. */
export type ServerEvent =
  | { type: "message.delta"; sessionId: string; text: string }
  | { type: "tool.start"; sessionId: string; callId: string; tool: string; args: unknown }
  | { type: "tool.delta"; sessionId: string; callId: string; chunk: string }
  | {
      type: "tool.end";
      sessionId: string;
      callId: string;
      status: "ok" | "error";
      /** Structured/extracted result — never raw spilled output (PLAN R2). */
      result?: unknown;
    }
  | {
      type: "permission.required";
      sessionId: string;
      permissionId: string;
      tool: string;
      preview: string;
    }
  | { type: "cost.update"; sessionId: string; costUsd: number; inputTokens: number; outputTokens: number }
  | { type: "context.meter"; sessionId: string; composition: ContextComposition }
  | { type: "turn.idle"; sessionId: string }
  | { type: "turn.error"; sessionId: string; message: string };

/** Client → server messages. */
export type ClientMessage =
  | { type: "user.message"; text: string }
  | { type: "permission.decision"; permissionId: string; allow: boolean }
  | { type: "interrupt" };

/** Token composition of the assembled context, surfaced by the context meter (PLAN R7/R10). */
export interface ContextComposition {
  system: number;
  tools: number;
  docs: number;
  history: number;
  files: number;
  /** output ÷ minimal-answer estimate for the current turn. */
  verbosityRatio: number;
  total: number;
}

/** Permission policy per tool (reads auto-allow; writes/bash gated). */
export type PermissionMode = "auto" | "ask" | "deny";
