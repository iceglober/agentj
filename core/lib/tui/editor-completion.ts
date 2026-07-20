import { type EditorState, splitGraphemes } from "./editor";

export type EditorSigil = "/" | "@";

export interface EditorCompletionToken {
  /** Grapheme offsets for the complete token, including its sigil. */
  start: number;
  end: number;
  sigil: EditorSigil;
  /** Text after the sigil, kept verbatim for provider-specific matching. */
  query: string;
}

export interface EditorCompletionSuggestion {
  /** Exact text inserted in place of the token. */
  value: string;
  /** Display text when it should differ from the inserted value. */
  label?: string;
  summary?: string;
}

export interface EditorCompletion {
  token: Pick<EditorCompletionToken, "start" | "end">;
  suggestions: readonly EditorCompletionSuggestion[];
  hint?: string;
}

/** Completion providers receive the complete editor text and grapheme cursor. */
export type EditorCompletionProvider = (state: EditorState) => EditorCompletion | null;

export interface CreateEditorCompletionProviderOptions {
  /** Preserves contextual completion for a top-level slash command and its arguments. */
  completeInitialSlash(state: EditorState): EditorCompletion | null;
  suggestInlineSlash(query: string): readonly EditorCompletionSuggestion[];
  suggestFiles(query: string): readonly EditorCompletionSuggestion[];
}

const whitespace = (value: string): boolean => /^\s$/u.test(value);

const tokenEnd = (value: readonly string[], start: number): number => {
  if (value[start] === "@" && value[start + 1] === '"') {
    let escaped = false;
    for (let index = start + 2; index < value.length; index += 1) {
      const grapheme = value[index] ?? "";
      if (grapheme === '"' && !escaped) return index + 1;
      escaped = grapheme === "\\" && !escaped;
      if (grapheme !== "\\") escaped = false;
    }
    return value.length;
  }
  let end = start + 1;
  while (end < value.length && !whitespace(value[end] ?? "")) end += 1;
  return end;
};

/** All sigil tokens whose leading character is at input start or follows whitespace. */
export const findEditorTokens = (text: string): EditorCompletionToken[] => {
  const value = splitGraphemes(text);
  const tokens: EditorCompletionToken[] = [];
  for (let start = 0; start < value.length; start += 1) {
    const sigil = value[start];
    if ((sigil !== "/" && sigil !== "@") || (start > 0 && !whitespace(value[start - 1] ?? "")))
      continue;
    const end = tokenEnd(value, start);
    tokens.push({ start, end, sigil, query: value.slice(start + 1, end).join("") });
    start = end - 1;
  }
  return tokens;
};

/** Token under the cursor. A cursor immediately after the sigil is active. */
export const findEditorToken = (state: EditorState): EditorCompletionToken | null => {
  const length = splitGraphemes(state.text).length;
  const cursor = Math.max(0, Math.min(state.cursor, length));
  return (
    findEditorTokens(state.text).find((token) => cursor > token.start && cursor <= token.end) ??
    null
  );
};

/** Compose command and file sources behind the single port consumed by the screen. */
export const createEditorCompletionProvider =
  (options: CreateEditorCompletionProviderOptions): EditorCompletionProvider =>
  (state) => {
    const token = findEditorToken(state);
    if (!token) return null;
    if (token.sigil === "@") {
      const query = token.query.startsWith('"')
        ? token.query.slice(1).replace(/\\\\"/gu, '"')
        : token.query;
      return { token, suggestions: options.suggestFiles(query) };
    }
    const first = splitGraphemes(state.text).findIndex((grapheme) => !whitespace(grapheme));
    if (token.start === first) return options.completeInitialSlash(state);
    return { token, suggestions: options.suggestInlineSlash(token.query) };
  };
