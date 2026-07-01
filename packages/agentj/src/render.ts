// Event rendering — turns the agent's `AgentEvent` stream into terminal output. Three quiet gutters
// distinguish who's "speaking": the input prompt (the user), `· ` a tool call, `● ` the assistant's
// text (dimmed). We keep one transient bottom status line for the in-flight tool / "thinking", but we
// only redraw it when the state changes — not on a timer — so the terminal stays easy to select/copy.
import type { AgentEvent } from "./events.ts";

/** Dim marker prefixing each assistant text run (reset to default fg after the glyph). */
const ASSISTANT_MARK = "\x1b[90m●\x1b[39m ";

/** Chars that begin a list/heading line — a marker before these reads as a double bullet,
 *  so we let those paragraphs render with their own leader instead. */
const LIST_LEAD = new Set(["-", "*", "+", "•", "#"]);
const startsListItem = (ch: string): boolean => LIST_LEAD.has(ch) || (ch >= "0" && ch <= "9");

function previewArgs(args: unknown): string {
  let s = "";
  try {
    s = JSON.stringify(args) ?? "";
  } catch {
    s = "";
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

const dim = (s: string): string => `\x1b[90m${s}\x1b[39m`;
const fmtMs = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Keep the tool line within one terminal row so the `\r` redraw stays in place. */
function fitLabel(label: string): string {
  const cols = process.stdout.columns ?? 80;
  return label.length > cols - 14 ? `${label.slice(0, cols - 15)}…` : label;
}

/**
 * A stateful renderer for one turn. Tracks whether we're mid-assistant-text so the `● `
 * marker is written once at the start of each text run (and re-applied after a tool
 * interrupts it), without prefixing every streamed token.
 */
export function createTurnRenderer(): { event(e: AgentEvent): void; finish(): void } {
  const tty = !!process.stdout.isTTY;
  let started = false; // any content (above the status line) written yet?
  const inflight = new Map<string, { call: string; start: number }>(); // callId → running call
  let statusOn = false; // is the transient status line currently drawn?

  const statusLine = (): string => {
    const running = [...inflight.values()];
    if (running.length) {
      const cur = running[running.length - 1];
      const more = running.length > 1 ? ` (+${running.length - 1})` : "";
      return dim(`… ${cur.call}${more}`);
    }
    return dim("… thinking");
  };
  const drawStatus = (): void => {
    if (!tty) return;
    process.stdout.write(`\r\x1b[K${statusLine()}`);
    statusOn = true;
  };
  const clearStatus = (): void => {
    if (statusOn) {
      process.stdout.write("\r\x1b[K");
      statusOn = false;
    }
  };

  const lead = (): void => {
    if (!started) {
      clearStatus();
      process.stdout.write("\n"); // one blank line between the prompt and the turn
      started = true;
    }
  };
  /** Print a finished line above the heartbeat (which redraws on the next tick). */
  const printAbove = (text: string): void => {
    clearStatus();
    process.stdout.write(`${text}\n`);
  };
  const writeAssistant = (text: string): void => {
    let buf = "";
    let nl = 2; // start of a run → the first line gets a marker too
    for (const ch of text) {
      if (ch === "\n") {
        buf += ch;
        nl++;
      } else {
        if (nl >= 2 && !startsListItem(ch)) buf += ASSISTANT_MARK; // skip the mark on list/heading lines
        buf += ch;
        nl = 0;
      }
    }
    printAbove(buf);
  };

  return {
    event(e: AgentEvent): void {
      switch (e.type) {
        case "message.delta": // one full chunk per step → terminate it so the heartbeat resumes below
          lead();
          writeAssistant(e.text);
          break;
        case "tool.start": {
          lead();
          inflight.set(e.callId, { call: fitLabel(`${e.tool}(${previewArgs(e.args)})`), start: Date.now() });
          drawStatus(); // TTY: reflect the now-running call immediately (no-op when piped)
          break;
        }
        case "tool.end": {
          const call = inflight.get(e.callId);
          inflight.delete(e.callId);
          const parts = [e.elapsedMs != null ? fmtMs(e.elapsedMs) : "", e.summary ?? e.status].filter(Boolean);
          printAbove(`· ${call?.call ?? "tool"} ${dim(`— ${parts.join(" ")}`)}`);
          break;
        }
        case "turn.note":
          lead();
          printAbove(dim(`» ${e.text}`));
          break;
        case "turn.error":
          lead();
          printAbove(`[error] ${e.message}`);
          break;
      }
    },
    finish(): void {
      const hadStatus = statusOn;
      clearStatus();
      // If the turn ended with the transient bottom line still occupying the cursor row, advance once so
      // the next prompt lands below the transcript instead of visually overlapping the final lines.
      if (hadStatus) process.stdout.write("\n");
    },
  };
}
