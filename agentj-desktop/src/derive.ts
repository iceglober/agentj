// Fold the raw event stream into transcript blocks + status metadata.
// Pure function: called on every render from the current event list.

import type { Block, StreamEvent, Subagent, ToolLine, Wave } from "./types";

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

  // Contiguous tool calls collapse into one block; `+` marks a call that
  // shares its step with the immediately-preceding tool call.
  let lastToolStep: number | null = null;
  let currentTool: ToolBlock | null = null;

  // Concurrent subagents group into a wave; a wave closes once every child ends.
  let currentWave: Wave | null = null;
  let waveCount = 0;
  const subById = new Map<number, Subagent>();

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

      case "subagent_start": {
        breakTool();
        if (!currentWave) {
          currentWave = { n: ++waveCount, subagents: [] };
          blocks.push({ type: "tray", wave: currentWave, id });
        }
        const sub: Subagent = {
          id: ev.data.id,
          desc: ev.data.desc,
          type: ev.data.agent_type,
          status: "",
          ok: null,
          elapsed_ms: null,
          summary: "",
          tokens: null,
          done: false,
        };
        currentWave.subagents.push(sub);
        subById.set(ev.data.id, sub);
        activity = "delegating";
        break;
      }

      case "subagent_progress": {
        const s = subById.get(ev.data.id);
        if (s) s.status = ev.data.status;
        activity = ev.data.status || "subagents…";
        break;
      }

      case "subagent_end": {
        const s = subById.get(ev.data.id);
        if (s) {
          s.done = true;
          s.ok = ev.data.ok;
          s.summary = ev.data.summary;
          s.elapsed_ms = ev.data.elapsed_ms;
        }
        if (currentWave && currentWave.subagents.every((x) => x.done)) {
          currentWave = null;
        }
        break;
      }

      case "subagent_usage": {
        const s = subById.get(ev.data.id);
        if (s) s.tokens = tokensOf(ev.data.usage);
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
