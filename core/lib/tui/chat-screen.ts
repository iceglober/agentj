import type { Readable } from "node:stream";
import type { PermissionPromptDecision, PermissionRequest } from "../agent/permissions";
import { type GuidedInputOptions, type GuidedInputPort, guidedChoice } from "../chat/guided-input";
import {
  applyEditorCommand,
  createEditorState,
  type EditorState,
  replaceEditorRange,
  splitGraphemes,
} from "./editor";
import type {
  EditorCompletionProvider,
  EditorCompletionSuggestion,
  EditorCompletionToken,
} from "./editor-completion";
import { highlightEditorLine } from "./editor-highlighting";
import { TerminalKeyDecoder } from "./key-decoder";
import { listOverflowFooter, windowList } from "./list-window";
import type { LiveLayout, LiveRegionPort } from "./live-region";
import { createTerminalStyler, type UiBlock, type UiTextLine } from "./styles";
import {
  displayWidth,
  escapeTerminalText,
  renderEditorLayout,
  windowEditorLayout,
  wrapToDisplayWidth,
} from "./terminal-editor";

/**
 * The persistent chat surface: raw mode for the whole session, one live
 * region at the bottom (optional progress block → editor rows → status line)
 * repainted in place, and an append-only transcript printed above it — the
 * same cursor-up/clear/repaint trick the DAG painter proved, generalized.
 * The screen renders and routes keys; it decides nothing (ChatSession does).
 */

interface RawInput extends Readable {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?(mode: boolean): this;
}

export interface ChatScreenCallbacks {
  onSubmit(text: string): void;
  onTab(): void;
  /** Reads copied attachments and returns an editor marker ready for insertion. */
  onPasteFiles?(): Promise<string | null>;
  onEscape(): void;
  /** Double Ctrl+C on an empty editor. */
  onQuit(): void;
}

export interface CreateChatScreenOptions {
  stdin?: Readable;
  /** Terminal output port, selected by the composition root. */
  liveRegion: LiveRegionPort;
  callbacks: ChatScreenCallbacks;
  /** Bare-ESC resolution delay; tests shrink it. */
  escapeFlushMs?: number;
  /** Double-Ctrl+C exit window. */
  quitWindowMs?: number;
  /** Previously submitted prompts, oldest first. */
  initialHistory?: readonly string[];
  /** Context-aware options for slash and @ tokens in the editor. */
  editorCompletionOptions?: EditorCompletionProvider;
  /** Whether a slash token still matches a command available in this chat. */
  matchesSlashCommand(query: string): boolean;
  /** Controls whether a submitted chat input is retained in in-memory history. */
  shouldRememberInput?(text: string): boolean;
}

export interface ChatScreen extends GuidedInputPort {
  start(): void;
  stop(): void;
  /** Append sanitized plain or semantic transcript output above the live region. */
  printAbove(text: string | UiBlock): void;
  /** Clear all rendered transcript output and repaint the live editor. */
  clearTranscript(): void;
  /** Restore a dequeued prompt, ahead of any draft already being edited. */
  restoreInput(text: string): void;
  /** Replace the progress block (empty array hides it). */
  setProgressLines(lines: UiTextLine[]): void;
  /** Ephemeral model-generation indicator, immediately above the editor. */
  setThinkingLine(line: UiTextLine | null): void;
  /** Replace the status section below the editor (idle repaints are skipped). */
  setStatusLines(lines: UiTextLine[]): void;
  /** Usable line width (columns minus the repaint-safety margin) for
   *  width-aware status composition — lines this long survive safeLine. */
  width(): number;
  /** Modal single-key permission prompt in the live region. */
  askPermission(request: PermissionRequest): Promise<PermissionPromptDecision>;
  /** Modal editor prompt. Escape cancels without submitting or retaining the value. */
  askInput(options: GuidedInputOptions): Promise<string | null>;
}

export function createChatScreen(options: CreateChatScreenOptions): ChatScreen {
  const stdin = (options.stdin ?? process.stdin) as RawInput;
  const liveRegion = options.liveRegion;
  const contentWidth = liveRegion.width;
  const styler = createTerminalStyler({ color: liveRegion.color() });
  const decoder = new TerminalKeyDecoder();
  let editor: EditorState = createEditorState();
  const history = (options.initialHistory ?? [])
    .filter((entry) => entry.trim().length > 0 && options.shouldRememberInput?.(entry) !== false)
    .slice(-100);
  let historyIndex: number | null = null;
  let progressLines: UiTextLine[] = [];
  let thinkingLine: UiTextLine | null = null;
  let statusLines: UiTextLine[] = [];
  let started = false;
  let removeResizeListener: (() => void) | null = null;
  let previousRawMode = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;
  let quitArmedAt = 0;
  let completionIndex = 0;
  let dismissedCompletion: string | null = null;
  interface PendingPermission {
    kind: "permission";
    request: PermissionRequest;
    resolve: (decision: PermissionPromptDecision) => void;
  }
  interface PendingInput {
    kind: "input";
    options: GuidedInputOptions;
    editor: EditorState;
    selectedIndex: number;
    error: string | null;
    resolve: (value: string | null) => void;
  }
  type PendingModal = PendingPermission | PendingInput;
  let pendingModal: PendingModal | null = null;
  const modalQueue: PendingModal[] = [];
  let inputQueue: Promise<void> | null = null;

  const safeLine = (line: UiTextLine): string => styler.renderLine(line, contentWidth());

  interface ActiveCompletion {
    token: Pick<EditorCompletionToken, "start" | "end">;
    suggestions: readonly EditorCompletionSuggestion[];
    selectedIndex: number;
    signature: string;
    hint?: string;
  }

  const editorSignature = (): string => `${editor.cursor}\u0000${editor.text}`;

  const activeCompletion = (): ActiveCompletion | null => {
    const signature = editorSignature();
    if (dismissedCompletion === signature) return null;
    const completion = options.editorCompletionOptions?.(editor);
    if (!completion || (completion.suggestions.length === 0 && !completion.hint)) return null;
    const length = splitGraphemes(editor.text).length;
    const start = Math.max(0, Math.min(completion.token.start, completion.token.end, length));
    const end = Math.max(
      start,
      Math.min(Math.max(completion.token.start, completion.token.end), length),
    );
    return {
      token: { start, end },
      suggestions: completion.suggestions,
      selectedIndex: Math.max(0, Math.min(completionIndex, completion.suggestions.length - 1)),
      signature,
      hint: completion.hint,
    };
  };

  const liveLines = (): LiveLayout => {
    const progress = progressLines.map(safeLine);
    const safeStatus = statusLines.map(safeLine);
    if (pendingModal?.kind === "permission") {
      const detail = permissionDetailLines(pendingModal.request);
      const origin = pendingModal.request.origin
        ? ` — ${escapeTerminalText(pendingModal.request.origin)}`
        : "";
      const permissionChoices =
        contentWidth() < 42
          ? [
              safeLine([{ text: "<Y>", tone: "accent", bold: true }, { text: " allow once" }]),
              safeLine([
                { text: "<A>", tone: "accent", bold: true },
                { text: " always this session" },
              ]),
              safeLine([{ text: "<N>", tone: "accent", bold: true }, { text: " deny" }]),
            ]
          : [
              safeLine([
                { text: "<Y>", tone: "accent", bold: true },
                { text: " allow once · " },
                { text: "<A>", tone: "accent", bold: true },
                { text: " always this session · " },
                { text: "<N>", tone: "accent", bold: true },
                { text: " deny" },
              ]),
            ];
      const askLines = [
        ...wrapToDisplayWidth(
          `Permission ${escapeTerminalText(pendingModal.request.tool)}${origin}`,
          contentWidth(),
        ),
        ...detail.lines,
        ...(detail.omitted > 0
          ? wrapToDisplayWidth(`  … +${detail.omitted} more lines`, contentWidth())
          : []),
        ...permissionChoices,
      ];
      const askCursorRow = progress.length + askLines.length - 1;
      return {
        lines: [...progress, ...askLines, ...safeStatus],
        cursorRow: askCursorRow,
        cursorColumn: displayWidth(askLines.at(-1) ?? ""),
      };
    }
    const editorActivity = [...progress, ...(thinkingLine ? [safeLine(thinkingLine)] : [])];
    // The transcript owns one blank separator. The live region owns the
    // second row above an idle editor, which active work replaces.
    const editorLead = editorActivity.length > 0 ? editorActivity : [""];
    if (pendingModal?.kind === "input") {
      const prompt = pendingModal;
      const labelLines = wrapToDisplayWidth(
        escapeTerminalText(prompt.options.label),
        contentWidth(),
      );
      const displayed = prompt.options.masked
        ? {
            ...prompt.editor,
            text: splitGraphemes(prompt.editor.text)
              .map((grapheme) => (grapheme === "\n" ? "\n" : "•"))
              .join(""),
          }
        : prompt.editor;
      const layout = windowEditorLayout(renderEditorLayout(displayed, contentWidth()), 10);
      const choiceWindow = windowList(
        (prompt.options.choices ?? []).map(guidedChoice),
        prompt.selectedIndex,
      );
      const choiceFooter = listOverflowFooter(choiceWindow);
      const choiceLines = [
        ...choiceWindow.items.flatMap((choice, index) => [
          safeLine(
            `${choiceWindow.start + index === prompt.selectedIndex ? "›" : " "} ${choice.label}`,
          ),
          ...(choice.description
            ? wrapToDisplayWidth(`  ${escapeTerminalText(choice.description)}`, contentWidth()).map(
                safeLine,
              )
            : []),
        ]),
        ...(choiceFooter ? [safeLine(choiceFooter)] : []),
      ];
      const errorLines = prompt.error
        ? wrapToDisplayWidth(escapeTerminalText(prompt.error), contentWidth())
        : [];
      return {
        lines: [
          ...editorLead,
          ...labelLines,
          ...layout.rows,
          ...choiceLines,
          ...errorLines,
          ...safeStatus,
        ],
        cursorRow: editorLead.length + labelLines.length + layout.cursorRow,
        cursorColumn: layout.cursorColumn,
      };
    }
    const layout = windowEditorLayout(renderEditorLayout(editor, contentWidth()), 10);
    const background = editor.text.startsWith("&");
    const editorRows = layout.rows.map((row, index) =>
      safeLine(
        highlightEditorLine(row, {
          background,
          firstRow: index === 0,
          matchesSlashCommand: options.matchesSlashCommand,
        }),
      ),
    );
    const backgroundLines = background
      ? [safeLine([{ text: "BACKGROUND JOB", tone: "warning", bold: true }])]
      : [];
    const completion = activeCompletion();
    const suggestionWindow = completion
      ? windowList(completion.suggestions, completion.selectedIndex)
      : null;
    const suggestionFooter = suggestionWindow ? listOverflowFooter(suggestionWindow) : null;
    const completionLines = suggestionWindow
      ? [
          ...suggestionWindow.items.map((suggestion, index) => {
            const summary = suggestion.summary ? ` — ${suggestion.summary}` : "";
            const marker = suggestionWindow.start + index === completion?.selectedIndex ? "›" : " ";
            return safeLine(`${marker} ${suggestion.label ?? suggestion.value}${summary}`);
          }),
          ...(suggestionFooter ? [safeLine(suggestionFooter)] : []),
        ]
      : [];
    const hintLines = completion?.hint
      ? wrapToDisplayWidth(escapeTerminalText(completion.hint), contentWidth())
      : [];
    return {
      lines: [
        ...editorLead,
        ...editorRows,
        ...completionLines,
        ...hintLines,
        ...backgroundLines,
        ...safeStatus,
      ],
      cursorRow: editorLead.length + layout.cursorRow,
      cursorColumn: layout.cursorColumn,
    };
  };

  const paint = (): void => {
    liveRegion.paint(liveLines());
  };

  const clearLive = (): void => {
    liveRegion.clear();
  };

  const printTranscript = (text: string | UiBlock): void => {
    liveRegion.printAbove(styler.renderBlock(text).join("\r\n"));
    paint();
  };

  const printPermissionRequest = (request: PermissionRequest): void => {
    const origin = request.origin ? ` (${request.origin})` : "";
    printTranscript(`Permission ${request.tool}${origin}:\n${request.detail}`);
  };

  /** The request rendered inside the modal: indented, wrapped, clamped. The
   *  full text goes to the transcript only when the clamp actually omits. */
  const PERMISSION_DETAIL_LINES = 6;
  const permissionDetailLines = (
    request: PermissionRequest,
  ): { lines: string[]; omitted: number } => {
    const wrapped = request.detail
      .split("\n")
      .flatMap((line) =>
        wrapToDisplayWidth(escapeTerminalText(line), Math.max(1, contentWidth() - 2)),
      );
    const shown = wrapped.slice(0, PERMISSION_DETAIL_LINES);
    return { lines: shown.map((line) => `  ${line}`), omitted: wrapped.length - shown.length };
  };

  const armEscapeFlush = (): void => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      for (const command of decoder.flush()) enqueueCommand(command);
    }, options.escapeFlushMs ?? 40);
  };

  const activateModal = (): void => {
    // Short requests live entirely in the modal; only a clamped request is
    // also printed above so its full text stays reviewable.
    if (
      pendingModal?.kind === "permission" &&
      permissionDetailLines(pendingModal.request).omitted > 0
    ) {
      printPermissionRequest(pendingModal.request);
    } else paint();
  };

  const settleModal = (
    modal: PendingModal,
    value: PermissionPromptDecision | string | null,
  ): void => {
    if (pendingModal !== modal) return;
    pendingModal = modalQueue.shift() ?? null;
    if (modal.kind === "permission") modal.resolve(value as PermissionPromptDecision);
    else modal.resolve(value as string | null);
    activateModal();
  };

  const handlePermissionKey = (
    modal: PendingPermission,
    command: { type: string; text?: string },
  ): void => {
    const key = command.type === "insert" ? command.text?.toLowerCase() : null;
    const decision =
      key === "y"
        ? "allow"
        : key === "a"
          ? "always"
          : key === "n" || command.type === "cancel" || command.type === "escape"
            ? "deny"
            : null;
    if (decision) settleModal(modal, decision);
  };

  const handleInputKey = (
    modal: PendingInput,
    command: ReturnType<TerminalKeyDecoder["push"]>[number],
  ): void => {
    if (command.type === "escape" || command.type === "cancel") {
      settleModal(modal, null);
      return;
    }
    const choices = (modal.options.choices ?? []).map(guidedChoice);
    if ((command.type === "move-up" || command.type === "move-down") && choices.length > 0) {
      const direction = command.type === "move-up" ? -1 : 1;
      modal.selectedIndex = (modal.selectedIndex + direction + choices.length) % choices.length;
      paint();
      return;
    }
    if (command.type === "tab" && choices.length > 0) {
      modal.editor = createEditorState(choices[modal.selectedIndex]?.value ?? "");
      modal.error = null;
      paint();
      return;
    }
    if (command.type === "submit") {
      const text =
        modal.editor.text.length === 0
          ? (choices[modal.selectedIndex]?.value ?? "")
          : modal.editor.text;
      const error = modal.options.validate?.(text);
      if (error) {
        modal.error = error;
        paint();
        return;
      }
      settleModal(modal, text);
      return;
    }
    modal.error = null;
    modal.editor = applyEditorCommand(modal.editor, command);
    paint();
  };

  /** Large pastes live here, off-screen: the editor holds a short placeholder
   *  (so the live region stays paintable) and submit expands it back. */
  const PASTE_PLACEHOLDER_CHARS = 1_000;
  const PASTE_PLACEHOLDER_LINES = 5;
  let pasteBuffer: string | null = null;
  let pasteCounter = 0;
  const pastes = new Map<string, string>();

  const clearPastes = (): void => {
    pastes.clear();
    pasteCounter = 0;
  };

  /** Replace each intact placeholder with its stored content. An edited
   *  placeholder no longer matches and submits literally — content is only
   *  ever substituted, never guessed. */
  const expandPastes = (text: string): string => {
    let expanded = text;
    for (const [placeholder, content] of pastes) {
      expanded = expanded.split(placeholder).join(content);
    }
    return expanded;
  };

  const commitPaste = (): void => {
    if (pasteBuffer === null) return;
    const text = pasteBuffer;
    pasteBuffer = null;
    // Modal inputs take pastes verbatim: their values must round-trip exactly.
    const oversized =
      pendingModal === null &&
      (splitGraphemes(text).length > PASTE_PLACEHOLDER_CHARS ||
        text.split("\n").length > PASTE_PLACEHOLDER_LINES);
    if (!oversized) {
      enqueueCommand({ type: "paste", text });
      return;
    }
    pasteCounter += 1;
    const placeholder = `[pasted content #${pasteCounter}: ${splitGraphemes(text).length} chars]`;
    pastes.set(placeholder, text);
    enqueueCommand({ type: "paste", text: placeholder });
  };

  const acceptCompletion = (completion: ActiveCompletion): void => {
    const selected = completion.suggestions[completion.selectedIndex];
    if (!selected) return;
    editor = replaceEditorRange(
      editor,
      completion.token.start,
      completion.token.end,
      selected.value,
    );
    historyIndex = null;
    completionIndex = 0;
    dismissedCompletion = selected.value.endsWith(" ") ? null : editorSignature();
    paint();
  };

  const browseHistory = (direction: -1 | 1): boolean => {
    if (history.length === 0) return false;
    if (historyIndex === null) {
      if (direction === 1 || editor.text.length > 0) return false;
      historyIndex = history.length - 1;
    } else {
      const next = historyIndex + direction;
      if (next >= history.length) {
        historyIndex = null;
        editor = createEditorState();
        dismissedCompletion = editorSignature();
        paint();
        return true;
      }
      historyIndex = Math.max(0, next);
    }
    editor = createEditorState(history[historyIndex] ?? "");
    dismissedCompletion = editorSignature();
    paint();
    return true;
  };

  const handleCommand = (
    command: ReturnType<TerminalKeyDecoder["push"]>[number],
  ): void | Promise<void> => {
    if (!started) return;
    if (pendingModal?.kind === "permission") {
      handlePermissionKey(pendingModal, command);
      return;
    }
    if (pendingModal?.kind === "input") {
      handleInputKey(pendingModal, command);
      return;
    }
    const completion = activeCompletion();
    switch (command.type) {
      case "paste-files":
        return (async () => {
          try {
            const references = await options.callbacks.onPasteFiles?.();
            if (!references || !started) return;
            historyIndex = null;
            completionIndex = 0;
            dismissedCompletion = null;
            editor = applyEditorCommand(editor, { type: "paste", text: references });
            paint();
          } catch {
            // The composition callback reports clipboard failures as notices.
          }
        })();
      case "tab":
        if (completion?.suggestions.length) acceptCompletion(completion);
        else if (!completion) options.callbacks.onTab();
        return;
      case "escape":
        if (completion) {
          dismissedCompletion = completion.signature;
          paint();
        } else options.callbacks.onEscape();
        return;
      case "submit": {
        const tokenText = completion
          ? splitGraphemes(editor.text).slice(completion.token.start, completion.token.end).join("")
          : "";
        const selectedValue = completion?.suggestions[completion.selectedIndex]?.value;
        const exact = selectedValue?.trimEnd() === tokenText;
        if (completion?.suggestions.length && !exact) {
          acceptCompletion(completion);
          return;
        }
        const text = expandPastes(editor.text);
        if (text.trim().length === 0) return;
        if (options.shouldRememberInput?.(text) !== false) {
          if (history.at(-1) !== text) history.push(text);
          if (history.length > 100) history.shift();
        }
        historyIndex = null;
        editor = createEditorState();
        completionIndex = 0;
        dismissedCompletion = null;
        clearPastes();
        paint();
        options.callbacks.onSubmit(text);
        return;
      }
      case "cancel": {
        if (editor.text.length > 0) {
          historyIndex = null;
          editor = createEditorState();
          completionIndex = 0;
          dismissedCompletion = null;
          clearPastes();
          paint();
          return;
        }
        const now = Date.now();
        if (now - quitArmedAt < (options.quitWindowMs ?? 1500)) {
          options.callbacks.onQuit();
          return;
        }
        quitArmedAt = now;
        options.callbacks.onEscape(); // Ctrl+C on empty editor also interrupts a turn
        return;
      }
      default:
        if (
          completion?.suggestions.length &&
          (command.type === "move-up" || command.type === "move-down")
        ) {
          const direction = command.type === "move-up" ? -1 : 1;
          completionIndex =
            (completion.selectedIndex + direction + completion.suggestions.length) %
            completion.suggestions.length;
          paint();
          return;
        }
        if (command.type === "move-up" && browseHistory(-1)) return;
        if (command.type === "move-down" && historyIndex !== null && browseHistory(1)) return;
        historyIndex = null;
        completionIndex = 0;
        dismissedCompletion = null;
        editor = applyEditorCommand(editor, command);
        paint();
    }
  };

  const enqueueCommand = (command: ReturnType<TerminalKeyDecoder["push"]>[number]): void => {
    const settle = (pending: Promise<void>): void => {
      inputQueue = pending;
      void pending.finally(() => {
        if (inputQueue === pending) inputQueue = null;
      });
    };
    if (inputQueue) {
      settle(inputQueue.then(() => Promise.resolve(handleCommand(command))).catch(() => {}));
      return;
    }
    const pending = handleCommand(command);
    if (pending) settle(pending.catch(() => {}));
  };

  const onResize = (): void => {
    if (started) paint();
  };

  const onData = (chunk: string | Buffer): void => {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    for (const command of decoder.push(chunk)) {
      // One user paste can arrive as several spans across chunks; coalesce
      // them so the placeholder decision sees the whole paste once.
      if (command.type === "paste") {
        pasteBuffer = (pasteBuffer ?? "") + command.text;
        continue;
      }
      commitPaste();
      enqueueCommand(command);
    }
    if (!decoder.midPaste) commitPaste();
    if (decoder.pendingLoneEscape) armEscapeFlush();
  };

  return {
    start() {
      if (started) return;
      started = true;
      previousRawMode = stdin.isRaw === true;
      stdin.on("data", onData);
      removeResizeListener = liveRegion.onResize(onResize);
      if (stdin.setRawMode && !previousRawMode) stdin.setRawMode(true);
      stdin.resume?.();
      liveRegion.setBracketedPaste(true);
      paint();
    },

    stop() {
      if (!started) return;
      started = false;
      if (escapeTimer) clearTimeout(escapeTimer);
      stdin.removeListener("data", onData);
      removeResizeListener?.();
      removeResizeListener = null;
      liveRegion.setBracketedPaste(false);
      if (stdin.setRawMode) stdin.setRawMode(previousRawMode);
      // A resumed stdin is a live handle that keeps the runtime alive after
      // the chat loop returns; without this, /quit tears down but never exits.
      stdin.pause?.();
      clearLive();
      const modals = pendingModal ? [pendingModal, ...modalQueue] : [...modalQueue];
      pendingModal = null;
      modalQueue.length = 0;
      for (const modal of modals) {
        if (modal.kind === "permission") modal.resolve("deny");
        else modal.resolve(null);
      }
    },

    printAbove(text) {
      printTranscript(text);
    },

    clearTranscript() {
      progressLines = [];
      thinkingLine = null;
      statusLines = [];
      liveRegion.clearScreen();
      paint();
    },

    restoreInput(text) {
      const draft = editor.text;
      editor = createEditorState(draft.length > 0 ? `${text}\n\n${draft}` : text);
      editor.cursor = splitGraphemes(text).length;
      historyIndex = null;
      completionIndex = 0;
      dismissedCompletion = null;
      paint();
    },

    setProgressLines(lines) {
      progressLines = lines;
      paint();
    },

    setThinkingLine(line) {
      if (thinkingLine === line) return;
      thinkingLine = line;
      paint();
    },

    width: contentWidth,

    setStatusLines(lines) {
      if (
        lines.length === statusLines.length &&
        lines.every((line, index) => line === statusLines[index])
      ) {
        return;
      }
      statusLines = lines;
      paint();
    },

    askPermission(request) {
      if (!started) return Promise.resolve("deny");
      return new Promise((resolve) => {
        const modal: PendingPermission = { kind: "permission", request, resolve };
        if (pendingModal) modalQueue.push(modal);
        else {
          pendingModal = modal;
          activateModal();
        }
      });
    },

    askInput(inputOptions) {
      if (!started) return Promise.resolve(null);
      return new Promise((resolve) => {
        const modal: PendingInput = {
          kind: "input",
          options: inputOptions,
          editor: createEditorState(inputOptions.initial),
          selectedIndex: 0,
          error: null,
          resolve,
        };
        if (pendingModal) modalQueue.push(modal);
        else {
          pendingModal = modal;
          activateModal();
        }
      });
    },
  };
}
