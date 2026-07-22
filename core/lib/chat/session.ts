import type { Agent } from "../agent";
import {
  extractReflectionSelection,
  type ReflectionEvent,
  type ReflectionPreparation,
} from "../agent/reflections";
import type { ImageAttachment } from "../llm";
import type { ChatLog, ChatMode } from "../session/log";
import type { UndoStack } from "../session/undo";
import type { ChatEvent } from "./events";

export interface SessionTodoLifecycle {
  list(): ReadonlyArray<{ status: "pending" | "in_progress" | "completed" }>;
  clear(): Promise<void>;
}

const hasOpenTodos = (todos: SessionTodoLifecycle | undefined): boolean =>
  todos?.list().some((todo) => todo.status !== "completed") ?? false;

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
  /** Request-context ceiling; old turns compact automatically at 75%. */
  contextSoftLimit?: number;
  onEvent?(event: ChatEvent): void | Promise<void>;
  /**
   * Optional composition-root continuation transform run after a successful
   * turn and before its durable state record. It receives opaque messages and
   * returns opaque messages; session logic never interprets either shape.
   */
  transformContinuation?(messages: unknown[], mode: ChatMode): Promise<unknown[]> | unknown[];
  /** Reflection runner; scheduling is controlled by reflectionEvents. */
  reflectPlan?(input: {
    request: string;
    draft: string;
    phase: "pre_turn" | "post_turn";
    abortSignal: AbortSignal;
    selectedIds?: readonly string[];
  }): Promise<ReflectionPreparation | null>;
  reflectionEvents?: readonly ReflectionEvent[];
  /** Backward-compatible post-turn hook for embedders. */
  refinePlan?(input: {
    request: string;
    draft: string;
    abortSignal: AbortSignal;
  }): Promise<ReflectionPreparation | null>;
  now?: () => string;
}

export interface ChatSessionInitialState {
  messages?: unknown[];
  mode?: ChatMode;
  reflectionOnce?: Partial<Record<"pre_turn" | "post_turn", boolean>>;
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
  /** Continue open work after a non-aborted background job, coalescing completions. */
  resumePendingWork(): void;
  /** Start a fresh model context and durable visible history. Returns false while busy. */
  clearContext(): Promise<boolean>;
  /** Compact old tool-heavy turns while preserving recent conversation. */
  compactContext(): Promise<boolean>;
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
  let reflectionOnce = { pre_turn: false, post_turn: false, ...initial.reflectionOnce };
  let busy = false;
  let turnAbort: AbortController | null = null;
  const notices: string[] = [];
  let resumeRunning = false;
  let resumeRequested = false;
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
    extraContext?: string,
    selectReflections = false,
    emitAssistant = true,
  ): Promise<{
    succeeded: boolean;
    mode: ChatMode;
    text?: string;
    selectedIds?: string[];
    stepLimitReached?: boolean;
  }> => {
    mode = fixedMode ?? pendingMode;
    turnAbort = new AbortController();
    const abort = turnAbort;
    emit({ type: "turn-started", mode, text, ...(transcriptText ? { transcriptText } : {}) });

    const drained = notices.splice(0);
    const baseContent = drained.length > 0 ? `${drained.join("\n")}\n\n${text}` : text;
    const content = extraContext ? `${baseContent}\n\n${extraContext}` : baseContent;

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
        ...(selectReflections ? { selectReflections: true } : {}),
      });
      const selectedIds = selectReflections
        ? extractReflectionSelection(result, agent.reflectionIds ?? [])
        : null;
      messages = result.messages ?? messages;
      // A draft plan that reflections will revise is deferred: showing it and
      // then a second, revised plan is confusing. The caller replays it only if
      // reflections fail to produce a revision.
      if (emitAssistant)
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
      const latestContext = result.steps.at(-1)?.usage?.inputTokens;
      const softLimit = deps.contextSoftLimit;
      if (softLimit && latestContext && latestContext >= softLimit * 0.75) {
        const compacted = agent.compactContinuation?.(messages) ?? messages;
        if (compacted !== messages) {
          messages = compacted;
          emit({ type: "notice", text: "Context compacted after reaching 75% of its soft limit." });
        }
      }
      await deps.log.append({ type: "state", messages, mode, reflectionOnce, ts: now() });
      return {
        succeeded: true,
        mode,
        text: result.text,
        ...(selectedIds !== null ? { selectedIds } : {}),
        ...(result.stepLimitReached ? { stepLimitReached: true } : {}),
      };
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
      if (pendingMode === "plan" && mode === "build")
        reflectionOnce = { pre_turn: false, post_turn: false };
      const reflectPlan =
        deps.reflectPlan ??
        (deps.refinePlan
          ? (input: {
              request: string;
              draft: string;
              phase: "pre_turn" | "post_turn";
              abortSignal: AbortSignal;
            }) =>
              input.phase === "post_turn"
                ? deps.refinePlan!({
                    request: input.request,
                    draft: input.draft,
                    abortSignal: input.abortSignal,
                  })
                : Promise.resolve(null)
          : undefined);
      const events = new Set(
        deps.reflectionEvents ?? (deps.refinePlan ? ["plan.once.post_turn" as const] : []),
      );
      const hook = (phase: "pre_turn" | "post_turn") => {
        const each = events.has(`plan.each.${phase}` as ReflectionEvent);
        const once = events.has(`plan.once.${phase}` as ReflectionEvent) && !reflectionOnce[phase];
        return each || once ? { once } : null;
      };
      let context: string | undefined;
      const pre = pendingMode === "plan" && reflectPlan ? hook("pre_turn") : null;
      if (pre) {
        if (pre.once) {
          reflectionOnce.pre_turn = true;
          await deps.log.append({ type: "state", messages, mode, reflectionOnce, ts: now() });
        }
        const controller = new AbortController();
        turnAbort = controller;
        try {
          const preparation = await reflectPlan!({
            request: text,
            draft: "",
            phase: "pre_turn",
            abortSignal: controller.signal,
          });
          if (preparation && "notice" in preparation)
            emit({ type: "notice", text: preparation.notice });
          else if (preparation && "context" in preparation) context = preparation.context;
        } finally {
          if (turnAbort === controller) turnAbort = null;
        }
      }
      const postDue = pendingMode === "plan" && reflectPlan ? hook("post_turn") : null;
      // When a post-turn reflection will revise the plan, hold the draft back so
      // the user sees only the revised plan; replay it if reflections don't land.
      const willRevise = postDue !== null && deps.reflectPlan !== undefined;
      const draft = await runExchange(
        text,
        transcriptText,
        images,
        undefined,
        context,
        willRevise,
        !willRevise,
      );
      let draftShown = false;
      const showDraft = (): void => {
        if (draftShown || !willRevise || !draft.succeeded || draft.text === undefined) return;
        draftShown = true;
        emit({
          type: "assistant",
          mode: draft.mode,
          text: draft.text,
          ...(draft.stepLimitReached ? { stepLimitReached: true } : {}),
        });
      };
      if (!draft.succeeded || draft.mode !== "plan" || !reflectPlan) {
        showDraft();
        return;
      }
      const post = postDue;
      if (!post) {
        showDraft();
        return;
      }
      const controller = new AbortController();
      turnAbort = controller;
      try {
        if (post.once) {
          reflectionOnce.post_turn = true;
          await deps.log.append({ type: "state", messages, mode, reflectionOnce, ts: now() });
        }
        const followUp = await reflectPlan({
          request: text,
          draft: draft.text ?? "",
          phase: "post_turn",
          abortSignal: controller.signal,
          ...(draft.selectedIds ? { selectedIds: draft.selectedIds } : {}),
        });
        if (followUp && "text" in followUp) {
          // The revised plan replaces the held-back draft.
          await runExchange(followUp.text, followUp.transcriptText, undefined, "plan");
        } else {
          // No revision landed: restore the draft, then note why if there was one.
          showDraft();
          if (followUp && "notice" in followUp) emit({ type: "notice", text: followUp.notice });
        }
      } catch (error) {
        showDraft();
        if (controller.signal.aborted) emit({ type: "turn-aborted" });
        else
          emit({
            type: "notice",
            text: `Reflections failed; keeping draft. (${error instanceof Error ? error.message : String(error)})`,
          });
      } finally {
        if (turnAbort === controller) turnAbort = null;
      }
    } finally {
      busy = false;
      if (pendingMode !== mode) emit({ type: "mode-changed", mode: pendingMode, pending: false });
      emit({ type: "submission-finished" });
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

  const send: ChatSession["send"] = async (text, options) => {
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
  };

  const resumePendingWork = (): void => {
    if (!hasOpenTodos(deps.todos)) return;
    resumeRequested = true;
    if (resumeRunning) return;
    resumeRunning = true;
    void (async () => {
      try {
        while (resumeRequested && hasOpenTodos(deps.todos)) {
          resumeRequested = false;
          await send(
            "[system] A background job finished. Continue the open session todos now. Do not wait or ask the user to send continue unless work is truly blocked.",
            { transcriptText: "[system] Background job completed — continuing open work" },
          );
        }
      } finally {
        resumeRunning = false;
      }
    })();
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

    send,

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

    resumePendingWork,

    async clearContext() {
      if (busy) return false;
      messages = [];
      notices.length = 0;
      await deps.todos?.clear();
      reflectionOnce = { pre_turn: false, post_turn: false };
      await deps.log.append({
        type: "state",
        messages,
        mode,
        reflectionOnce,
        ts: now(),
        reset: true,
      });
      emit({ type: "context-cleared" });
      return true;
    },

    async compactContext() {
      if (busy) return false;
      const agent = await deps.agentFor(mode);
      const compacted = agent.compactContinuation?.(messages) ?? messages;
      const changed = compacted !== messages;
      messages = compacted;
      await deps.log.append({ type: "state", messages, mode, reflectionOnce, ts: now() });
      emit({
        type: "notice",
        text: changed ? "Context compacted." : "Context is already compact.",
      });
      return true;
    },

    snapshot() {
      return { messages, mode };
    },
  };
}
