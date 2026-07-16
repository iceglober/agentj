import type { Agent } from "../agent";
import type { ChatLog, ChatMode } from "../session/log";
import type { UndoStack } from "../session/undo";
import type { ChatEvent } from "./events";

/**
 * The persistent chat loop's core: one foreground turn at a time over an
 * opaque message continuation, mode toggling between turns, message queueing,
 * and durable turn/state records. Pure logic — no TTY, no process state; the
 * composition root injects agents, log, and undo, and the screen renders the
 * emitted events.
 */

export interface ChatSessionDependencies {
  /** Mode-specific agents; the composition root caches per mode. */
  agentFor(mode: ChatMode): Promise<Agent>;
  log: ChatLog;
  /** Present in repos only; snapshots are taken before each build turn. */
  undo?: UndoStack;
  onEvent?(event: ChatEvent): void | Promise<void>;
  now?: () => string;
}

export interface ChatSessionInitialState {
  messages?: unknown[];
  mode?: ChatMode;
}

export interface ChatSession {
  readonly mode: ChatMode;
  /** The mode the NEXT turn will use (differs from mode while a turn runs). */
  readonly pendingMode: ChatMode;
  readonly busy: boolean;
  /** Toggle or set the next turn's mode; applies immediately when idle. */
  setMode(mode?: ChatMode): ChatMode;
  /**
   * Submit a user message. Runs the turn now, or queues it when one is
   * already running (queued messages run in order). Resolves when this
   * message's turn has completed.
   */
  send(text: string): Promise<void>;
  /** Abort the running foreground turn. Returns false when idle. */
  abort(): boolean;
  /** Queue a notice prepended to the next user turn (job completions). */
  addTurnNotice(text: string): void;
  /** The resumable continuation for the session log. */
  snapshot(): { messages: unknown[]; mode: ChatMode };
}

export function createChatSession(
  deps: ChatSessionDependencies,
  initial: ChatSessionInitialState = {},
): ChatSession {
  const now = deps.now ?? (() => new Date().toISOString());
  let mode: ChatMode = initial.mode ?? "plan";
  let pendingMode: ChatMode = mode;
  let messages: unknown[] = initial.messages ?? [];
  let busy = false;
  let turnAbort: AbortController | null = null;
  const notices: string[] = [];
  const queue: Array<{ text: string; resolve: () => void }> = [];

  const emit = (event: ChatEvent): void => {
    void deps.onEvent?.(event);
  };

  const runTurn = async (text: string): Promise<void> => {
    mode = pendingMode;
    busy = true;
    turnAbort = new AbortController();
    emit({ type: "turn-started", mode, text });

    const drained = notices.splice(0);
    const content = drained.length > 0 ? `${drained.join("\n")}\n\n${text}` : text;

    try {
      if (mode === "build") await deps.undo?.snapshot("pre-turn");
      const agent = await deps.agentFor(mode);
      const result = await agent.generate(content, {
        abortSignal: turnAbort.signal,
        onStep: (step) => {
          for (const call of step.toolCalls) emit({ type: "tool-call", call });
          for (const toolResult of step.toolResults)
            emit({ type: "tool-result", result: toolResult });
        },
        messages,
      });
      messages = result.messages ?? messages;
      emit({
        type: "assistant",
        mode,
        text: result.text,
        ...(result.stepLimitReached ? { stepLimitReached: true } : {}),
      });
      await deps.log.append({ type: "turn", mode, user: text, assistant: result.text, ts: now() });
      await deps.log.append({ type: "state", messages, mode, ts: now() });
    } catch (error) {
      if (turnAbort.signal.aborted) {
        emit({ type: "turn-aborted" });
        // The model should know the turn was cut short on the next turn.
        notices.push(`[note] The previous turn ("${text.slice(0, 60)}") was interrupted.`);
      } else {
        emit({
          type: "turn-error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      busy = false;
      turnAbort = null;
      if (pendingMode !== mode) emit({ type: "mode-changed", mode: pendingMode, pending: false });
    }
  };

  const drainQueue = async (): Promise<void> => {
    while (queue.length > 0 && !busy) {
      const next = queue.shift();
      if (!next) break;
      await runTurn(next.text);
      next.resolve();
    }
  };

  return {
    get mode() {
      return mode;
    },
    get pendingMode() {
      return pendingMode;
    },
    get busy() {
      return busy;
    },

    setMode(next) {
      pendingMode = next ?? (pendingMode === "plan" ? "build" : "plan");
      if (!busy) mode = pendingMode;
      emit({ type: "mode-changed", mode: pendingMode, pending: busy });
      return pendingMode;
    },

    async send(text) {
      if (busy) {
        emit({ type: "turn-queued", text });
        await new Promise<void>((resolve) => {
          queue.push({ text, resolve });
        });
        return;
      }
      await runTurn(text);
      await drainQueue();
    },

    abort() {
      if (!turnAbort) return false;
      turnAbort.abort();
      return true;
    },

    addTurnNotice(text) {
      notices.push(text);
    },

    snapshot() {
      return { messages, mode };
    },
  };
}
