// The ~5 events the renderer consumes. `agent.ts` emits these via an `emit(event)` callback wired
// straight to `render.ts`'s `event()`. No sessionId, no SSE — one local session.
export type AgentEvent =
  | { type: "message.delta"; text: string }
  | { type: "tool.start"; callId: string; tool: string; args: unknown }
  | { type: "tool.end"; callId: string; status: "ok" | "error"; elapsedMs?: number; summary?: string }
  | { type: "turn.note"; text: string } // supervisor/lifecycle line (auto-continue, hit the step cap, …)
  | { type: "turn.error"; message: string };

export type Emit = (e: AgentEvent) => void;
