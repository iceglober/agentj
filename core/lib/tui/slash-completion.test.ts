import { describe, expect, test } from "bun:test";
import { createEditorState } from "./editor";
import { findSlashCommandToken, type SlashCompletionProvider } from "./slash-completion";

describe("findSlashCommandToken", () => {
  test("finds an initial command with leading whitespace and an empty query", () => {
    expect(findSlashCommandToken({ ...createEditorState("  /bld args"), cursor: 6 })).toEqual({
      start: 2,
      end: 6,
      query: "bld",
    });
    expect(findSlashCommandToken(createEditorState("/"))).toEqual({
      start: 0,
      end: 1,
      query: "",
    });
  });

  test("stays active while the cursor edits the command token", () => {
    const state = createEditorState("/build later");
    expect(findSlashCommandToken({ ...state, cursor: 3 })?.query).toBe("build");
    expect(findSlashCommandToken({ ...state, cursor: 8 })).toBeNull();
  });

  test("ignores inline slashes and non-command text", () => {
    expect(findSlashCommandToken(createEditorState("say /bld"))).toBeNull();
    expect(findSlashCommandToken(createEditorState("build/"))).toBeNull();
  });

  test("completion providers can inspect the full editor and target nested tokens", () => {
    const provider: SlashCompletionProvider = ({ text, cursor }) => ({
      token: { start: text.lastIndexOf(" ") + 1, end: cursor },
      suggestions: [{ value: "typescript", label: "TypeScript", summary: "Use TS" }],
      hint: `Completing ${text.slice(0, cursor)}`,
    });

    expect(provider(createEditorState("/config language type"))).toEqual({
      token: { start: 17, end: 21 },
      suggestions: [{ value: "typescript", label: "TypeScript", summary: "Use TS" }],
      hint: "Completing /config language type",
    });
  });
});
