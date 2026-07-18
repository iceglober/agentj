import type { Readable, Writable } from "node:stream";
import type { PermissionPromptDecision, PermissionRequest } from "../agent/permissions";
import type { GuidedInputOptions, GuidedInputPort } from "../chat/guided-input";
import {
  applyEditorCommand,
  createEditorState,
  type EditorState,
  replaceEditorRange,
  splitGraphemes,
} from "./editor";
import { TerminalKeyDecoder } from "./key-decoder";
import { listOverflowMarkers, windowList } from "./list-window";
import {
  findSlashCommandToken,
  type SlashCompletionProvider,
  type SlashCompletionSuggestion,
  type SlashCompletionToken,
} from "./slash-completion";
import {
  displayWidth,
  escapeTerminalText,
  renderEditorLayout,
  truncateToDisplayWidth,
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

interface TerminalOutput extends Writable {
  columns?: number;
}

export interface ChatScreenCallbacks {
  onSubmit(text: string): void;
  onTab(): void;
  onEscape(): void;
  /** Double Ctrl+C on an empty editor. */
  onQuit(): void;
}

export interface SlashCommandSuggestion {
  name: string;
  summary: string;
}

export interface CreateChatScreenOptions {
  stdin?: Readable;
  stdout?: Writable;
  terminalWidth?: number | (() => number);
  callbacks: ChatScreenCallbacks;
  /** Bare-ESC resolution delay; tests shrink it. */
  escapeFlushMs?: number;
  /** Double-Ctrl+C exit window. */
  quitWindowMs?: number;
  /** Previously submitted prompts, oldest first. */
  initialHistory?: readonly string[];
  /** Context-aware options for any slash-command token. */
  slashCommandOptions?: SlashCompletionProvider;
  /** Legacy initial-command suggestions. Prefer `slashCommandOptions`. */
  slashCommandSuggestions?(query: string): readonly SlashCommandSuggestion[];
  /** Controls whether a submitted chat input is retained in in-memory history. */
  shouldRememberInput?(text: string): boolean;
}

export interface ChatScreen extends GuidedInputPort {
  start(): void;
  stop(): void;
  /** Append transcript output above the live region. */
  /** Append transcript output. Text is sanitized against terminal-escape
   *  injection unless `preStyled` — then the CALLER must have sanitized any
   *  interpolated content before adding its own trusted ANSI styling. */
  printAbove(text: string, options?: { preStyled?: boolean }): void;
  /** Restore a dequeued prompt, ahead of any draft already being edited. */
  restoreInput(text: string): void;
  /** Replace the progress block (empty array hides it). */
  setProgressLines(lines: string[]): void;
  /** Replace the status section below the editor (idle repaints are skipped). */
  setStatusLines(lines: string[]): void;
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
  const stdout = (options.stdout ?? process.stdout) as TerminalOutput;
  const width = (): number =>
    Math.max(
      1,
      Math.floor(
        typeof options.terminalWidth === "function"
          ? options.terminalWidth()
          : (options.terminalWidth ?? stdout.columns ?? 80),
      ),
    );
  const contentWidth = (): number => Math.max(1, width() - 1);

  const decoder = new TerminalKeyDecoder();
  let editor: EditorState = createEditorState();
  const history = (options.initialHistory ?? [])
    .filter((entry) => entry.trim().length > 0 && options.shouldRememberInput?.(entry) !== false)
    .slice(-100);
  let historyIndex: number | null = null;
  let progressLines: string[] = [];
  let statusLines: string[] = [];
  let started = false;
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

  const write = (text: string): void => {
    stdout.write(text);
  };

  interface LiveLayout {
    lines: string[];
    cursorRow: number;
    cursorColumn: number;
  }

  const safeLine = (line: string): string =>
    truncateToDisplayWidth(escapeTerminalText(line).replace(/\n+/gu, " "), contentWidth());

  interface ActiveCompletion {
    token: SlashCompletionToken;
    suggestions: readonly SlashCompletionSuggestion[];
    selectedIndex: number;
    signature: string;
    hint?: string;
    legacy: boolean;
    legacyMovePastSeparator: boolean;
  }

  const editorSignature = (): string => `${editor.cursor}\u0000${editor.text}`;

  const activeCompletion = (): ActiveCompletion | null => {
    const signature = editorSignature();
    if (dismissedCompletion === signature) return null;

    if (options.slashCommandOptions) {
      const completion = options.slashCommandOptions(editor);
      if (!completion || (completion.suggestions.length === 0 && !completion.hint)) return null;
      const length = splitGraphemes(editor.text).length;
      const start = Math.max(0, Math.min(completion.token.start, completion.token.end, length));
      const end = Math.max(
        start,
        Math.min(Math.max(completion.token.start, completion.token.end), length),
      );
      const suggestions = completion.suggestions;
      return {
        token: { start, end },
        suggestions,
        selectedIndex: Math.max(0, Math.min(completionIndex, suggestions.length - 1)),
        signature,
        hint: completion.hint,
        legacy: false,
        legacyMovePastSeparator: false,
      };
    }

    const token = findSlashCommandToken(editor);
    if (!token || !options.slashCommandSuggestions) return null;
    const hasSeparator = token.end < splitGraphemes(editor.text).length;
    const suggestions = options.slashCommandSuggestions(token.query).map(({ name, summary }) => ({
      value: `/${name}${hasSeparator ? "" : " "}`,
      label: `/${name}`,
      summary,
    }));
    if (suggestions.length === 0) return null;
    return {
      token,
      suggestions,
      selectedIndex: Math.min(completionIndex, suggestions.length - 1),
      signature,
      legacy: true,
      legacyMovePastSeparator: hasSeparator,
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
      const askLines = [
        ...wrapToDisplayWidth(
          `Permission ${escapeTerminalText(pendingModal.request.tool)}${origin}`,
          contentWidth(),
        ),
        ...detail.lines,
        ...(detail.omitted > 0
          ? wrapToDisplayWidth(`  … +${detail.omitted} more lines`, contentWidth())
          : []),
        ...wrapToDisplayWidth("[y]es once · [a]lways this session · [n]o", contentWidth()),
      ];
      const askCursorRow = progress.length + askLines.length - 1;
      return {
        lines: [...progress, ...askLines, ...safeStatus],
        cursorRow: askCursorRow,
        cursorColumn: displayWidth(askLines.at(-1) ?? ""),
      };
    }
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
      const layout = renderEditorLayout(displayed, contentWidth());
      const choiceWindow = windowList(prompt.options.choices ?? [], prompt.selectedIndex);
      const choiceMarkers = listOverflowMarkers(choiceWindow);
      const choiceLines = [
        ...(choiceMarkers.above ? [safeLine(choiceMarkers.above)] : []),
        ...choiceWindow.items.map((choice, index) =>
          safeLine(`${choiceWindow.start + index === prompt.selectedIndex ? "›" : " "} ${choice}`),
        ),
        ...(choiceMarkers.below ? [safeLine(choiceMarkers.below)] : []),
      ];
      const errorLines = prompt.error
        ? wrapToDisplayWidth(escapeTerminalText(prompt.error), contentWidth())
        : [];
      return {
        lines: [
          ...progress,
          ...labelLines,
          ...layout.rows,
          ...choiceLines,
          ...errorLines,
          ...safeStatus,
        ],
        cursorRow: progress.length + labelLines.length + layout.cursorRow,
        cursorColumn: layout.cursorColumn,
      };
    }
    const layout = renderEditorLayout(editor, contentWidth());
    const completion = activeCompletion();
    const suggestionWindow = completion
      ? windowList(completion.suggestions, completion.selectedIndex)
      : null;
    const suggestionMarkers = suggestionWindow ? listOverflowMarkers(suggestionWindow) : null;
    const completionLines = suggestionWindow
      ? [
          ...(suggestionMarkers?.above ? [safeLine(suggestionMarkers.above)] : []),
          ...suggestionWindow.items.map((suggestion, index) => {
            const summary = suggestion.summary ? ` — ${suggestion.summary}` : "";
            const marker = suggestionWindow.start + index === completion?.selectedIndex ? "›" : " ";
            return safeLine(`${marker} ${suggestion.label ?? suggestion.value}${summary}`);
          }),
          ...(suggestionMarkers?.below ? [safeLine(suggestionMarkers.below)] : []),
        ]
      : [];
    const hintLines = completion?.hint
      ? wrapToDisplayWidth(escapeTerminalText(completion.hint), contentWidth())
      : [];
    return {
      lines: [...progress, ...layout.rows, ...completionLines, ...hintLines, ...safeStatus],
      cursorRow: progress.length + layout.cursorRow,
      cursorColumn: layout.cursorColumn,
    };
  };

  const csi = (sequence: string): string => `\u001b[${sequence}`;
  const bracketedPaste = (enabled: boolean): string => csi(`?2004${enabled ? "h" : "l"}`);

  /** The previous logical layout is retained so a resize can account for
   * terminal reflow before climbing back to the live region's first row. */
  let lastLayout: LiveLayout | null = null;

  const physicalCursorRow = (layout: LiveLayout): number => {
    const terminalWidth = width();
    const rowsBefore = layout.lines
      .slice(0, layout.cursorRow)
      .reduce(
        (total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / terminalWidth)),
        0,
      );
    const cursorWrap =
      layout.cursorColumn === 0
        ? 0
        : Math.floor(Math.max(0, layout.cursorColumn - 1) / terminalWidth);
    return rowsBefore + cursorWrap;
  };

  const moveToRegionTop = (): void => {
    const cursorRow = lastLayout ? physicalCursorRow(lastLayout) : 0;
    if (cursorRow > 0) write(csi(`${cursorRow}A`));
    write(`\r${csi("J")}`);
  };

  const paint = (): void => {
    const layout = liveLines();
    moveToRegionTop();
    write(layout.lines.join("\r\n"));
    const up = layout.lines.length - 1 - layout.cursorRow;
    write(
      `\r${up > 0 ? csi(`${up}A`) : ""}${layout.cursorColumn > 0 ? csi(`${layout.cursorColumn}C`) : ""}`,
    );
    lastLayout = layout;
  };

  const clearLive = (): void => {
    if (lastLayout) moveToRegionTop();
    lastLayout = null;
  };

  const printTranscript = (text: string, preStyled = false): void => {
    clearLive();
    write(`${(preStyled ? text : escapeTerminalText(text)).split("\n").join("\r\n")}\r\n`);
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
      for (const command of decoder.flush()) handleCommand(command);
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
    const choices = modal.options.choices ?? [];
    if ((command.type === "move-up" || command.type === "move-down") && choices.length > 0) {
      const direction = command.type === "move-up" ? -1 : 1;
      modal.selectedIndex = (modal.selectedIndex + direction + choices.length) % choices.length;
      paint();
      return;
    }
    if (command.type === "tab" && choices.length > 0) {
      modal.editor = createEditorState(choices[modal.selectedIndex] ?? "");
      modal.error = null;
      paint();
      return;
    }
    if (command.type === "submit") {
      const text =
        modal.editor.text.length === 0 ? (choices[modal.selectedIndex] ?? "") : modal.editor.text;
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

  const acceptCompletion = (completion: ActiveCompletion): void => {
    const selected = completion.suggestions[completion.selectedIndex];
    if (!selected) return;
    editor = replaceEditorRange(
      editor,
      completion.token.start,
      completion.token.end,
      selected.value,
    );
    if (completion.legacyMovePastSeparator) editor = { ...editor, cursor: editor.cursor + 1 };
    historyIndex = null;
    completionIndex = 0;
    dismissedCompletion = editorSignature();
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

  const handleCommand = (command: ReturnType<TerminalKeyDecoder["push"]>[number]): void => {
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
        const exact = completion?.legacy
          ? selectedValue?.trimEnd().toLowerCase() === tokenText.toLowerCase()
          : selectedValue?.trimEnd() === tokenText;
        if (completion?.suggestions.length && !exact) {
          acceptCompletion(completion);
          return;
        }
        const text = editor.text;
        if (text.trim().length === 0) return;
        if (options.shouldRememberInput?.(text) !== false) {
          if (history.at(-1) !== text) history.push(text);
          if (history.length > 100) history.shift();
        }
        historyIndex = null;
        editor = createEditorState();
        completionIndex = 0;
        dismissedCompletion = null;
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

  const onResize = (): void => {
    if (started) paint();
  };

  const onData = (chunk: string | Buffer): void => {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    for (const command of decoder.push(chunk)) handleCommand(command);
    if (decoder.pendingLoneEscape) armEscapeFlush();
  };

  return {
    start() {
      if (started) return;
      started = true;
      previousRawMode = stdin.isRaw === true;
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      if (stdin.setRawMode && !previousRawMode) stdin.setRawMode(true);
      stdin.resume?.();
      write(bracketedPaste(true));
      paint();
    },

    stop() {
      if (!started) return;
      started = false;
      if (escapeTimer) clearTimeout(escapeTimer);
      stdin.removeListener("data", onData);
      stdout.removeListener("resize", onResize);
      write(bracketedPaste(false));
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
      write("\r\n");
    },

    printAbove(text, options) {
      printTranscript(text, options?.preStyled === true);
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
          editor: createEditorState(),
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
