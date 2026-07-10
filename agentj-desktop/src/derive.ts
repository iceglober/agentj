// Fold the raw event stream into transcript blocks + status metadata.
// Pure function: called on every render from the current event list.

import type { Block, StreamEvent, ToolLine } from "./types";

export interface Derived {
  blocks: Block[];
  totalTokens: number;
  activity: string;
  sawDone: boolean;
}

type ToolBlock = Extract<Block, { type: "tool" }>;

function tokensOf(u: {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}): number {
  return u.total_tokens || u.prompt_tokens + u.completion_tokens;
}

export function derive(events: StreamEvent[]): Derived {
  const blocks: Block[] = [];
  let totalTokens = 0;
  let activity = "working…";
  let sawDone = false;

  // Contiguous tool calls collapse into one block; `+` marks a call that shares its step with the
  // immediately-preceding tool call. `run_subagents` renders as an ordinary tool row, and each of its
  // subagents gets its OWN tool row too (via subagent_start/_end) so you can watch them run + finish.
  let lastToolStep: number | null = null;
  let currentTool: ToolBlock | null = null;
  const subLine = new Map<number, ToolLine>(); // subagent id → its (mutable) tool row

  const breakTool = () => {
    currentTool = null;
    lastToolStep = null;
  };

  events.forEach((ev, i) => {
    const id = "b" + i;
    switch (ev.kind) {
      case "user":
        breakTool();
        blocks.push({ type: "card", role: "you", text: ev.data, id });
        activity = "sent";
        break;

      case "message":
        breakTool();
        blocks.push({ type: "card", role: "agentj", text: ev.data, id });
        activity = "replying";
        break;

      case "thinking":
        breakTool();
        blocks.push({ type: "thinking", text: ev.data, id });
        activity = "thinking";
        break;

      case "note":
        breakTool();
        blocks.push({ type: "note", text: ev.data, id });
        activity = ev.data.replace(/^»\s*/, "").trim() || "note";
        break;

      case "notice":
        breakTool();
        blocks.push({ type: "notice", text: ev.data, id });
        break;

      case "step_limit":
        breakTool();
        blocks.push({ type: "note", text: `» step gate — ${ev.data} steps`, id });
        activity = "step gate";
        break;

      case "error":
        breakTool();
        blocks.push({ type: "error", text: ev.data, id });
        activity = "error";
        break;

      case "usage":
        totalTokens += tokensOf(ev.data);
        break;

      case "artifact":
        breakTool();
        blocks.push({
          type: "note",
          text: `» saved artifact \`${ev.data.name}\``,
          id,
        });
        break;

      case "tool_start": {
        const shares = lastToolStep !== null && ev.data.step === lastToolStep;
        const line: ToolLine = {
          prefix: shares ? "+" : "·",
          name: ev.data.name,
          args: ev.data.args,
          elapsed_ms: null,
          summary: "",
          result: "",
          ok: true,
          pending: true,
        };
        if (currentTool) {
          currentTool.lines.push(line);
        } else {
          currentTool = { type: "tool", lines: [line], id };
          blocks.push(currentTool);
        }
        lastToolStep = ev.data.step;
        activity = `tool: ${ev.data.name}`;
        break;
      }

      case "tool_end": {
        const line = currentTool?.lines.find((l) => l.pending);
        if (line) {
          line.pending = false;
          line.ok = ev.data.ok;
          line.elapsed_ms = ev.data.elapsed_ms;
          line.summary = ev.data.summary;
          line.result = ev.data.result;
          if (!ev.data.ok) line.prefix = "✗"; // failure wins over `·`/`+`
        }
        break;
      }

      // Each subagent is a plain tool row: appears (pending) on start, completes on end — same
      // visual as any tool call, so you can see what's running and when each finishes.
      case "subagent_start": {
        const line: ToolLine = {
          prefix: "·",
          name: ev.data.desc || "subagent",
          args: ev.data.agent_type || "",
          elapsed_ms: null,
          summary: "",
          result: "",
          ok: true,
          pending: true,
        };
        if (currentTool) {
          currentTool.lines.push(line);
        } else {
          currentTool = { type: "tool", lines: [line], id };
          blocks.push(currentTool);
        }
        subLine.set(ev.data.id, line);
        activity = "delegating";
        break;
      }
      case "subagent_progress":
        activity = ev.data.status || "subagents…";
        break;
      case "subagent_end": {
        const line = subLine.get(ev.data.id);
        if (line) {
          line.pending = false;
          line.ok = ev.data.ok;
          line.elapsed_ms = ev.data.elapsed_ms;
          line.summary = ev.data.summary;
          line.result = ev.data.summary;
          if (!ev.data.ok) line.prefix = "✗";
        }
        break;
      }

      case "done":
        breakTool();
        sawDone = true;
        activity = "all set";
        break;
    }
  });

  return { blocks, totalTokens, activity, sawDone };
}
