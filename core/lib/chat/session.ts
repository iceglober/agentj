import type { Agent } from "../agent";
import type { ImageAttachment } from "../llm";
import type { ChatLog, ChatMode } from "../session/log";
import type { UndoStack } from "../session/undo";
import type { ChatEvent } from "./events";

export interface SessionTodoLifecycle {
  clear(): Promise<void>;
}

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
  /** Optional session-owned state cleared with model context and history. */
  todos?: SessionTodoLifecycle;
  onEvent?(event: ChatEvent): void | Promise<void>;
  /**
   * Optional composition-root continuation transform run after a successful
   * turn and before its durable state record. It receives opaque messages and
   * returns opaque messages; session logic never interprets either shape.
   */
  transformContinuation?(messages: unknown[], mode: ChatMode): Promise<unknown[]> | unknown[];
  /** Optional one-shot plan refinement after a durable draft plan. */
  refinePlan?(input: {
    request: string;
    draft: string;
    abortSignal: AbortSignal;
  }): Promise<{ text: string; transcriptText: string } | { notice: string } | null>;
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
  send(
    text: string,
    options?: {
      transcriptText?: string;
      restoreText?: string;
      images?: readonly ImageAttachment[];
    },
  ): Promise<void>;
  /** Abort the running foreground turn. Returns false when idle. */
  abort(): boolean;
  /**
   * Remove the most recently queued message (LIFO — escape undoes the latest
   * intent) and resolve its `send()` promise. Returns the removed text, or
   * null when nothing is queued.
   */
  dequeue(): string | null;
  /** Queue a notice prepended to the next user turn (job completions). */
  addTurnNotice(text: string): void;
  /** Start a fresh model context and durable visible history. Returns false while busy. */
  clearContext(): Promise<boolean>;
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
  const queue: Array<{
    text: string;
    transcriptText?: string;
    restoreText?: string;
    images?: readonly ImageAttachment[];
    resolve: () => void;
  }> = [];

  const emit = (event: ChatEvent): void => {
    void deps.onEvent?.(event);
  };

  const runExchange = async (
    text: string,
    transcriptText?: string,
    images?: readonly ImageAttachment[],
    fixedMode?: ChatMode,
  ): Promise<{ succeeded: boolean; mode: ChatMode; text?: string }> => {
    mode = fixedMode ?? pendingMode;
    turnAbort = new AbortController();
    const abort = turnAbort;
    emit({ type: "turn-started", mode, text, ...(transcriptText ? { transcriptText } : {}) });

    const drained = notices.splice(0);
    const content = drained.length > 0 ? `${drained.join("\n")}\n\n${text}` : text;

    try {
      if (mode === "build") await deps.undo?.snapshot("pre-turn");
      const agent = await deps.agentFor(mode);
      const result = await agent.generate(content, {
        abortSignal: abort.signal,
        onStep: (step) => {
          for (const call of step.toolCalls) emit({ type: "tool-call", call });
          for (const toolResult of step.toolResults)
            emit({ type: "tool-result", result: toolResult });
          if (step.usage) emit({ type: "turn-usage", usage: step.usage });
        },
        messages,
        ...(images && images.length > 0 ? { images } : {}),
      });
      messages = result.messages ?? messages;
      emit({
        type: "assistant",
        mode,
        text: result.text,
        ...(result.stepLimitReached ? { stepLimitReached: true } : {}),
      });
      if (result.stepLimitReached)
        notices.push("[note] The previous turn stopped at the step limit before finishing.");
      await deps.log.append({
        type: "turn",
        mode,
        user: text,
        assistant: result.text,
        ts: now(),
        ...(transcriptText ? { transcriptText } : {}),
      });
      if (deps.transformContinuation) messages = await deps.transformContinuation(messages, mode);
      await deps.log.append({ type: "state", messages, mode, ts: now() });
      return { succeeded: true, mode, text: result.text };
    } catch (error) {
      if (abort.signal.aborted) {
        emit({ type: "turn-aborted" });
        notices.push(`[note] The previous turn ("${text.slice(0, 60)}") was interrupted.`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "turn-error", error: message });
        notices.push(
          `[note] The previous turn failed (${message.slice(0, 200)}) before completing. Its request was: "${text.slice(0, 2_000)}". If the user asks to retry or continue, act on that request.`,
        );
      }
      return { succeeded: false, mode };
    } finally {
      if (turnAbort === abort) turnAbort = null;
      emit({ type: "turn-finished" });
    }
  };

  const runTurn = async (
    text: string,
    transcriptText?: string,
    images?: readonly ImageAttachment[],
  ): Promise<void> => {
    busy = true;
    try {
      const draft = await runExchange(text, transcriptText, images);
      if (!draft.succeeded || draft.mode !== "plan" || !deps.refinePlan) return;

      const refinementAbort = new AbortController();
      turnAbort = refinementAbort;
      try {
        const followUp = await deps.refinePlan({
          request: text,
          draft: draft.text ?? "",
          abortSignal: refinementAbort.signal,
        });
        if (followUp && "notice" in followUp) emit({ type: "notice", text: followUp.notice });
        else if (followUp)
          await runExchange(followUp.text, followUp.transcriptText, undefined, "plan");
      } catch (error) {
        if (refinementAbort.signal.aborted) emit({ type: "turn-aborted" });
        else
          emit({
            type: "notice",
            text: `Reflections failed; keeping draft. (${error instanceof Error ? error.message : String(error)})`,
          });
      } finally {
        if (turnAbort === refinementAbort) turnAbort = null;
      }
    } finally {
      busy = false;
      if (pendingMode !== mode) emit({ type: "mode-changed", mode: pendingMode, pending: false });
    }
  };

  const drainQueue = async (): Promise<void> => {
    while (queue.length > 0 && !busy) {
      const next = queue.shift();
      if (!next) break;
      await runTurn(next.text, next.transcriptText, next.images);
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

    async send(text, options) {
      const transcriptText = options?.transcriptText;
      const restoreText = options?.restoreText;
      const images = options?.images;
      if (busy) {
        emit({
          type: "turn-queued",
          text,
          ...(transcriptText ? { transcriptText } : {}),
          ...(restoreText ? { restoreText } : {}),
        });
        await new Promise<void>((resolve) => {
          queue.push({
            text,
            ...(transcriptText ? { transcriptText } : {}),
            ...(restoreText ? { restoreText } : {}),
            ...(images && images.length > 0 ? { images } : {}),
            resolve,
          });
        });
        return;
      }
      await runTurn(text, transcriptText, images);
      await drainQueue();
    },

    abort() {
      if (!turnAbort) return false;
      if (!turnAbort.signal.aborted) {
        turnAbort.abort();
        emit({ type: "turn-abort-requested" });
      }
      return true;
    },

    dequeue() {
      const entry = queue.pop();
      if (!entry) return null;
      emit({
        type: "turn-dequeued",
        text: entry.text,
        ...(entry.restoreText ? { restoreText: entry.restoreText } : {}),
      });
      entry.resolve();
      return entry.text;
    },

    addTurnNotice(text) {
      notices.push(text);
    },

    async clearContext() {
      if (busy) return false;
      messages = [];
      notices.length = 0;
      await deps.todos?.clear();
      await deps.log.append({ type: "state", messages, mode, ts: now(), reset: true });
      emit({ type: "context-cleared" });
      return true;
    },

    snapshot() {
      return { messages, mode };
    },
  };
}
