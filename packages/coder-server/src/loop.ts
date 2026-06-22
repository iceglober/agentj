// The agent loop — coder owns its loop on the Vercel AI SDK `streamText` + tool-exec
// cycle (the one large delta from glrs, which delegated to the OpenCode SDK). Streaming,
// interruptible, multi-provider, with `experimental_telemetry` for per-call tokens/cost.
//
// The provider is behind a thin `ModelProvider` seam so the loop stays testable against
// a mock model (PLAN N5) and the AI SDK wiring lands in P1 without touching this shape.
import type { ServerEvent, Succinctness, Tier } from "coder-core";
import type { Tool, ToolContext } from "./tools/index.ts";

export interface ModelTurn {
  /** Streamed assistant text deltas. */
  text: AsyncIterable<string>;
  /** Tool calls the model requested this turn. */
  toolCalls(): Promise<Array<{ callId: string; tool: string; args: unknown }>>;
  /** "end_turn" | "tool_use" — drives loop continuation. */
  stopReason(): Promise<"end_turn" | "tool_use">;
  usage(): Promise<{ inputTokens: number; outputTokens: number; costUsd: number }>;
}

export interface ModelProvider {
  /** One model call. Implemented over AI SDK `streamText` in P1; mocked in tests. */
  stream(req: {
    tier: Tier;
    succinctness: Succinctness;
    system: string;
    messages: unknown[];
    tools: Tool[];
  }): ModelTurn;
}

export interface LoopDeps {
  provider: ModelProvider;
  tools: Map<string, Tool>;
  toolCtx: ToolContext;
  emit(event: ServerEvent): void;
  /** Cooperative cancellation for interrupt (PLAN R8). */
  signal: AbortSignal;
}

/**
 * Run one task to completion: model → tool calls → execute → loop until end_turn.
 * Skeleton of the cycle; the model/tool wiring is filled in P1.
 */
export async function runLoop(
  sessionId: string,
  system: string,
  messages: unknown[],
  tier: Tier,
  succinctness: Succinctness,
  deps: LoopDeps,
): Promise<void> {
  while (!deps.signal.aborted) {
    const turn = deps.provider.stream({ tier, succinctness, system, messages, tools: [...deps.tools.values()] });

    for await (const delta of turn.text) {
      deps.emit({ type: "message.delta", sessionId, text: delta });
    }

    const stop = await turn.stopReason();
    if (stop === "end_turn") {
      deps.emit({ type: "turn.idle", sessionId });
      return;
    }

    // tool_use: execute each requested tool, gating writes/bash, then loop.
    for (const call of await turn.toolCalls()) {
      deps.emit({ type: "tool.start", sessionId, callId: call.callId, tool: call.tool, args: call.args });
      const tool = deps.tools.get(call.tool);
      try {
        if (!tool) throw new Error(`unknown tool: ${call.tool}`);
        const result = await tool.run(call.args as Record<string, unknown>, deps.toolCtx);
        deps.emit({ type: "tool.end", sessionId, callId: call.callId, status: "ok", result });
        // TODO(P1): append tool_result to `messages`; route noisy output via Extractors.
      } catch (err) {
        deps.emit({
          type: "tool.end",
          sessionId,
          callId: call.callId,
          status: "error",
          result: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
