import { describe, expect, test } from "bun:test";

import {
  applyEditorCommand,
  createEditorState,
  splitGraphemes,
  type EditorCommand,
  type EditorState,
} from "./editor";

const apply = (state: EditorState, ...commands: EditorCommand[]): EditorState =>
  commands.reduce(applyEditorCommand, state);

describe("prompt editor model", () => {
  test("inserts text and newlines, moves by character, and deletes in both directions", () => {
    let state = apply(
      createEditorState(),
      { type: "insert", text: "ac" },
      { type: "move-left" },
      { type: "insert", text: "b" },
      { type: "newline" },
      { type: "insert", text: "d" },
    );
    expect(state).toMatchObject({ text: "ab\ndc", cursor: 4 });

    state = apply(state, { type: "delete-backward" }, { type: "delete-forward" });
    expect(state).toMatchObject({ text: "ab\n", cursor: 3 });
    expect(apply(createEditorState("x"), { type: "move-right" }).cursor).toBe(1);
    expect(apply({ ...createEditorState("x"), cursor: 0 }, { type: "move-left" }).cursor).toBe(0);
  });

  test("hops and deletes words consistently across punctuation and whitespace", () => {
    const end = createEditorState("alpha,  beta");
    const betaStart = apply(end, { type: "move-word-left" });
    expect(betaStart.cursor).toBe(8);
    expect(apply(betaStart, { type: "move-word-left" }).cursor).toBe(0);

    const start = { ...end, cursor: 0 };
    const alphaEnd = apply(start, { type: "move-word-right" });
    expect(alphaEnd.cursor).toBe(5);
    expect(apply(alphaEnd, { type: "move-word-right" }).cursor).toBe(12);

    expect(apply(end, { type: "delete-word-backward" }).text).toBe("alpha,  ");
    expect(apply(start, { type: "delete-word-forward" }).text).toBe(",  beta");
    expect(
      apply({ ...createEditorState(",  beta"), cursor: 0 }, { type: "delete-word-forward" }).text,
    ).toBe("");
  });

  test("line movement and deletion never cross newline boundaries", () => {
    const text = "one\ntwo three\nfour";
    const middle = { ...createEditorState(text), cursor: 7 };
    expect(apply(middle, { type: "move-line-start" }).cursor).toBe(4);
    expect(apply(middle, { type: "move-line-end" }).cursor).toBe(13);
    expect(apply(middle, { type: "delete-line-backward" }).text).toBe("one\n three\nfour");
    expect(apply(middle, { type: "delete-line-forward" }).text).toBe("one\ntwo\nfour");

    const lineStart = { ...createEditorState(text), cursor: 4 };
    expect(apply(lineStart, { type: "delete-line-backward" })).toEqual(lineStart);
    const lineEnd = { ...createEditorState(text), cursor: 13 };
    expect(apply(lineEnd, { type: "delete-line-forward" })).toEqual(lineEnd);
  });

  test("line and vertical commands stay on the first line when the cursor is at offset 0", () => {
    const top = { ...createEditorState("abcd\nx\nwxyz"), cursor: 0 };
    expect(apply(top, { type: "move-line-start" }).cursor).toBe(0);
    expect(apply(top, { type: "move-line-end" }).cursor).toBe(4);
    expect(apply(top, { type: "delete-line-backward" })).toEqual(top);
    expect(apply(top, { type: "delete-line-forward" }).text).toBe("\nx\nwxyz");
    expect(apply(top, { type: "move-down" })).toMatchObject({ cursor: 5, preferredColumn: 0 });
  });

  test("vertical arrows retain the intended column through short lines", () => {
    const firstLineEnd = { ...createEditorState("abcd\nx\nwxyz"), cursor: 4 };
    const shortLine = apply(firstLineEnd, { type: "move-down" });
    expect(shortLine).toMatchObject({ cursor: 6, preferredColumn: 4 });
    expect(apply(shortLine, { type: "move-down" })).toMatchObject({
      cursor: 11,
      preferredColumn: 4,
    });
    expect(apply(shortLine, { type: "move-up" }).cursor).toBe(4);
  });

  test("edits grapheme clusters without splitting Unicode characters", () => {
    const text = "A👨‍👩‍👧‍👦éB";
    expect(splitGraphemes(text)).toEqual(["A", "👨‍👩‍👧‍👦", "é", "B"]);

    const beforeB = apply(createEditorState(text), { type: "move-left" });
    expect(apply(beforeB, { type: "delete-backward" })).toMatchObject({
      text: "A👨‍👩‍👧‍👦B",
      cursor: 2,
    });
    expect(apply({ ...createEditorState(text), cursor: 1 }, { type: "delete-forward" }).text).toBe(
      "AéB",
    );
  });

  test("submit and cancel leave model state unchanged", () => {
    const state = createEditorState("ready");
    expect(apply(state, { type: "submit" })).toBe(state);
    expect(apply(state, { type: "cancel" })).toBe(state);
  });
});
