// The model loop. Wraps the Vercel AI SDK's ToolLoopAgent: each turn runs the model, executes the
// tools it calls, and loops until it stops (or hits the step cap). Non-streaming on purpose — Vertex
// mangles Gemini thought-signatures when streaming a tool replay.
//
// Auto-continue: the step cap is a runaway guard, not a "you're done" signal. When the model exhausts
// a step window while STILL calling tools (finishReason "tool-calls"), it wasn't finished — so instead
// of stopping silently we ask a cheap supervisor (a single structured model call over a tail of recent
// activity) whether it's making progress or thrashing. If progress, we inject one line of guidance and
// run another window; if not, we stop and say why. Bounded by AGENTJ_MAX_CONTINUES so it can't loop
// forever. Natural completion (the model stops calling tools) needs no supervisor — the loop just ends.
import { generateObject, type LanguageModel, type ModelMessage, stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { trace } from "@opentelemetry/api";
import { z } from "zod";
import type { AgentEvent, Emit } from "./events.ts";
import { addSpanEvent, eventAttributes, recordError, withSpan } from "./otel.ts";

/** Parse a non-negative int env var, honoring an explicit 0 (which `Number(x) || def` would drop). */
function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

/** Steps per window before we pause to supervise. Override with AGENTJ_MAX_STEPS (min 1). */
const MAX_STEPS = Math.max(1, envInt("AGENTJ_MAX_STEPS", 40));
/** How many times auto-continue may extend a turn past the first window (0 disables it). Override with AGENTJ_MAX_CONTINUES. */
const MAX_CONTINUES = envInt("AGENTJ_MAX_CONTINUES", 3);

const asMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** First line of a tool result, clipped — a one-glance summary for the tool.end line + the tail. */
function summarize(res: unknown): string {
  const s = typeof res === "string" ? res : (() => { try { return JSON.stringify(res); } catch { return String(res); } })();
  const first = (s ?? "").split("\n", 1)[0] ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/**
 * Wrap each tool's execute to emit tool.start/tool.end for the renderer AND record a compact activity
 * line into `activity` (used to build the supervisor's tail). Tools return strings and rarely throw;
 * the catch is a backstop.
 */
function instrument(tools: ToolSet, emit: Emit, activity: string[]): ToolSet {
  const parent = trace.getActiveSpan();
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [name, t] of Object.entries(tools)) {
    const orig = (t as { execute?: (a: unknown, o: unknown) => unknown }).execute;
    if (typeof orig !== "function") {
      out[name] = t;
      continue;
    }
    out[name] = {
      ...(t as object),
      execute: async (args: unknown, options: unknown) => {
        const callId = `t${++n}`;
        const start = Date.now();
        emit({ type: "tool.start", callId, tool: name, args });
        parent?.addEvent("agentj.tool.start", eventAttributes("tool.start", { "agentj.tool.name": name, "agentj.tool.call_id": callId, "agentj.tool.args": args }));
        let argStr = "";
        try {
          argStr = clip(JSON.stringify(args) ?? "", 100);
        } catch {
          argStr = "";
        }
        return await withSpan("agentj.tool", { "agentj.tool.name": name, "agentj.tool.call_id": callId }, async (span) => {
          try {
            const res = await orig(args, options);
            const s = summarize(res);
            activity.push(`${name}(${argStr}) → ${s}`);
            span.setAttributes({ "agentj.tool.status": "ok", "agentj.tool.elapsed_ms": Date.now() - start, "agentj.tool.summary": s });
            emit({ type: "tool.end", callId, status: "ok", elapsedMs: Date.now() - start, summary: s });
            parent?.addEvent("agentj.tool.end", eventAttributes("tool.end", { "agentj.tool.name": name, "agentj.tool.call_id": callId, "agentj.tool.status": "ok", "agentj.tool.elapsed_ms": Date.now() - start, "agentj.tool.summary": s }));
            return res;
          } catch (err) {
            const message = asMsg(err);
            activity.push(`${name}(${argStr}) → ERROR ${message}`);
            span.setAttributes({ "agentj.tool.status": "error", "agentj.tool.elapsed_ms": Date.now() - start, "agentj.tool.summary": message });
            recordError(span, err);
            emit({ type: "tool.end", callId, status: "error", elapsedMs: Date.now() - start, summary: message });
            parent?.addEvent("agentj.tool.end", eventAttributes("tool.end", { "agentj.tool.name": name, "agentj.tool.call_id": callId, "agentj.tool.status": "error", "agentj.tool.elapsed_ms": Date.now() - start, "agentj.tool.summary": message }));
            throw err;
          }
        });
      },
    };
  }
  return out as ToolSet;
}

const SteerDecision = z.object({
  proceed: z.boolean().describe("true if the agent is making real progress and should keep going; false if finished, stuck, or off track"),
  reason: z.string().describe("one sentence — shown to the user when stopping"),
  guidance: z.string().optional().describe("when proceeding, ONE concrete line to keep the agent on track"),
});

/** Ask a cheap supervisor whether the mid-task agent should continue. One structured model call. */
async function superviseContinue(model: LanguageModel, task: string, tail: string, meta: { provider?: string; modelId?: string }): Promise<z.infer<typeof SteerDecision>> {
  return await withSpan(
    "agentj.model.generate_object",
    {
      "agentj.model.phase": "supervisor",
      "agentj.model.provider": meta.provider ?? "unknown",
      "agentj.model.id": meta.modelId ?? "unknown",
      "agentj.task.length": task.length,
      "agentj.activity.tail_length": tail.length,
    },
    async (span) => {
      const { object } = await generateObject({
        model,
        schema: SteerDecision,
        system:
          "You supervise an autonomous coding agent that just hit a step checkpoint mid-task. Decide whether it should keep going. proceed=true if it is making real progress toward the task and is NOT finished. proceed=false if it looks finished, is stuck repeating the same failing action, or has drifted off the task. When proceeding, give ONE concrete line of guidance to keep it on track (e.g. what to verify next). Be decisive.",
        prompt: `TASK:\n${task}\n\nRECENT ACTIVITY (oldest first, newest last):\n${tail}\n\nShould the agent continue?`,
      });
      span.setAttributes({ "agentj.supervisor.proceed": object.proceed, "agentj.supervisor.has_guidance": !!object.guidance });
      addSpanEvent(span, "agentj.supervisor.decision", eventAttributes("supervisor.decision", { "agentj.supervisor.proceed": object.proceed, "agentj.supervisor.reason": object.reason, "agentj.supervisor.has_guidance": !!object.guidance }));
      return object;
    },
  );
}

/** The current task = the most recent user message (in our flows always a plain string). */
function currentTask(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const c = messages[i].content;
      return typeof c === "string" ? c : clip(JSON.stringify(c), 2000);
    }
  }
  return "(unknown task)";
}

export interface RunTurnResult {
  /** True when the turn completed (or was a clean abort); false on a model/transport error. */
  ok: boolean;
  /** Full message history including this turn's assistant + tool messages — feed it to the next turn. */
  messages: ModelMessage[];
  /** Set when the turn was interrupted by the abort signal (Ctrl-C). */
  aborted?: boolean;
  /** Set on a hard failure. */
  error?: string;
}

/** Run one turn: prior `messages` already include the new user turn. Emits events to `emit`. */
export async function runTurn(opts: {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  messages: ModelMessage[];
  emit: Emit;
  signal?: AbortSignal;
  /** Model for the auto-continue supervisor check. Defaults to `model` (set AGENTJ_STEER_MODEL for a cheaper one). */
  steerModel?: LanguageModel;
  modelId?: string;
  provider?: string;
}): Promise<RunTurnResult> {
  const activity: string[] = [];
  const task = currentTask(opts.messages);
  return await withSpan(
    "agentj.turn",
    {
      "agentj.model.provider": opts.provider ?? "unknown",
      "agentj.model.id": opts.modelId ?? "unknown",
      "agentj.max_steps": MAX_STEPS,
      "agentj.max_continues": MAX_CONTINUES,
      "agentj.message.count": opts.messages.length,
      "agentj.task.length": task.length,
    },
    async (turnSpan) => {
      addSpanEvent(turnSpan, "agentj.interaction.user", eventAttributes("interaction.user", { "agentj.prompt": task, "agentj.prompt.length": task.length }));
      const tools = instrument(opts.tools, opts.emit, activity);
      const agent = new ToolLoopAgent({ model: opts.model, instructions: opts.system, tools, stopWhen: stepCountIs(MAX_STEPS) });
      const steerModel = opts.steerModel ?? opts.model;
      let messages = opts.messages;
      let continues = 0;

      try {
        for (;;) {
          const result = await withSpan(
            "agentj.model.generate",
            {
              "agentj.model.phase": "main",
              "agentj.model.provider": opts.provider ?? "unknown",
              "agentj.model.id": opts.modelId ?? "unknown",
              "agentj.message.count": messages.length,
            },
            async (modelSpan) =>
              await agent.generate({
                messages,
                abortSignal: opts.signal,
                onStepFinish: (step: { text?: string }) => {
                  if (step.text) {
                    opts.emit({ type: "message.delta", text: step.text });
                    activity.push(`assistant: ${clip(step.text, 200)}`);
                    addSpanEvent(modelSpan, "agentj.message.delta", eventAttributes("message.delta", { "agentj.message.length": step.text.length, "agentj.message.text": clip(step.text, 400) }));
                    addSpanEvent(turnSpan, "agentj.message.delta", eventAttributes("message.delta", { "agentj.message.length": step.text.length, "agentj.message.text": clip(step.text, 400) }));
                  }
                },
              }),
          );
          messages = [...messages, ...result.response.messages];
          turnSpan.setAttributes({ "agentj.finish_reason": result.finishReason, "agentj.response.message_count": result.response.messages.length });
          addSpanEvent(turnSpan, "agentj.model.finish", eventAttributes("model.finish", { "agentj.finish_reason": result.finishReason, "agentj.response.message_count": result.response.messages.length }));

          if (result.finishReason !== "tool-calls") return { ok: true, messages };

          if (continues >= MAX_CONTINUES) {
            const text = `stopped at the step limit (${MAX_STEPS}×${MAX_CONTINUES + 1} steps) — type 'continue' to keep going, or raise AGENTJ_MAX_STEPS / AGENTJ_MAX_CONTINUES.`;
            opts.emit({ type: "turn.note", text });
            addSpanEvent(turnSpan, "agentj.turn.note", eventAttributes("turn.note", { "agentj.note": text }));
            return { ok: true, messages };
          }

          const tail = clip(activity.slice(-25).join("\n"), 4000);
          let decision: z.infer<typeof SteerDecision>;
          try {
            decision = await superviseContinue(steerModel, task, tail, { provider: opts.provider, modelId: opts.modelId });
          } catch (err) {
            const text = `couldn't auto-continue (supervisor check failed: ${asMsg(err)}) — type 'continue' to keep going.`;
            opts.emit({ type: "turn.note", text });
            addSpanEvent(turnSpan, "agentj.turn.note", eventAttributes("turn.note", { "agentj.note": text }));
            return { ok: true, messages };
          }
          if (!decision.proceed) {
            const text = `stopping: ${decision.reason}`;
            opts.emit({ type: "turn.note", text });
            addSpanEvent(turnSpan, "agentj.turn.note", eventAttributes("turn.note", { "agentj.note": text }));
            return { ok: true, messages };
          }
          continues++;
          const text = `auto-continuing (${continues}/${MAX_CONTINUES})${decision.guidance ? ` — ${decision.guidance}` : ""}`;
          opts.emit({ type: "turn.note", text });
          addSpanEvent(turnSpan, "agentj.turn.note", eventAttributes("turn.note", { "agentj.note": text, "agentj.continues": continues }));
          messages = [...messages, { role: "user", content: `[auto-continue] Keep going on the task until it's actually complete and verified.${decision.guidance ? ` Guidance: ${decision.guidance}` : ""}` }];
        }
      } catch (err) {
        if (opts.signal?.aborted) {
          turnSpan.setAttribute("agentj.aborted", true);
          addSpanEvent(turnSpan, "agentj.turn.aborted", eventAttributes("turn.aborted"));
          return { ok: false, messages, aborted: true };
        }
        const message = asMsg(err);
        opts.emit({ type: "turn.error", message });
        addSpanEvent(turnSpan, "agentj.turn.error", eventAttributes("turn.error", { "agentj.error": message }));
        recordError(turnSpan, err);
        return { ok: false, messages, error: message };
      }
    },
  );
}

/** Re-export for callers that want to construct events directly (headless renderer). */
export type { AgentEvent };
