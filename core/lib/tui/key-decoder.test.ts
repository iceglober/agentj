import { describe, expect, test } from "bun:test";

import type { EditorCommand } from "./editor";
import { TerminalKeyDecoder } from "./key-decoder";

const decode = (...chunks: Array<string | Uint8Array>): EditorCommand[] => {
  const decoder = new TerminalKeyDecoder();
  return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
};

describe("terminal key decoder", () => {
  test("passes through ordinary Unicode input across byte chunk boundaries", () => {
    const bytes = new TextEncoder().encode("a🙂");
    expect(decode(bytes.slice(0, 3), bytes.slice(3))).toEqual([
      { type: "insert", text: "a" },
      { type: "insert", text: "🙂" },
    ]);
  });

  test("distinguishes Return from supported Shift+Return encodings", () => {
    expect(decode("\r", "\u001b[13;2u", "\u001b[27;2;13~", "\u001b[13;2~")).toEqual([
      { type: "submit" },
      { type: "newline" },
      { type: "newline" },
      { type: "newline" },
    ]);
  });

  test("decodes Option word movement and deletion encodings and aliases", () => {
    expect(
      decode(
        "\u001b[1;3D",
        "\u001b[1;3C",
        "\u001bb",
        "\u001bf",
        "\u001b\u007f",
        "\u001bd",
        "\u001b[127;3u",
        "\u001b[3;3~",
      ),
    ).toEqual([
      { type: "move-word-left" },
      { type: "move-word-right" },
      { type: "move-word-left" },
      { type: "move-word-right" },
      { type: "delete-word-backward" },
      { type: "delete-word-forward" },
      { type: "delete-word-backward" },
      { type: "delete-word-forward" },
    ]);
  });

  test("decodes Cmd line movement and deletion from Super modifier bits", () => {
    expect(decode("\u001b[1;9D", "\u001b[1;9C", "\u001b[127;9u", "\u001b[3;9~")).toEqual([
      { type: "move-line-start" },
      { type: "move-line-end" },
      { type: "delete-line-backward" },
      { type: "delete-line-forward" },
    ]);
  });

  test("supports arrows, Home/End, Delete, and conventional control aliases", () => {
    expect(
      decode(
        "\u001b[D",
        "\u001b[C",
        "\u001b[A",
        "\u001b[B",
        "\u001bOH",
        "\u001bOF",
        "\u001b[3~",
        "\u0001\u0005\u0015\u000b",
      ),
    ).toEqual([
      { type: "move-left" },
      { type: "move-right" },
      { type: "move-up" },
      { type: "move-down" },
      { type: "move-line-start" },
      { type: "move-line-end" },
      { type: "delete-forward" },
      { type: "move-line-start" },
      { type: "move-line-end" },
      { type: "delete-line-backward" },
      { type: "delete-line-forward" },
    ]);
  });

  test("supports Kitty CSI-u functional key codes", () => {
    expect(decode("\u001b[57350;3u", "\u001b[57351;9u", "\u001b[57349;3u")).toEqual([
      { type: "move-word-left" },
      { type: "move-line-end" },
      { type: "delete-word-forward" },
    ]);
  });

  test("maps Kitty Home/End and ignores Caps Lock and Scroll Lock", () => {
    expect(decode("\u001b[57356u", "\u001b[57357u", "\u001b[57358u", "\u001b[57359u")).toEqual([
      { type: "move-line-start" },
      { type: "move-line-end" },
    ]);
  });

  test("a retained bare Escape does not corrupt the following escape sequence", () => {
    const decoder = new TerminalKeyDecoder();
    expect(decoder.push("\u001b")).toEqual([]);
    expect(decoder.push("\u001b[D")).toEqual([{ type: "move-left" }]);
    expect(decoder.end()).toEqual([]);
  });

  test("buffers partial escape sequences", () => {
    const decoder = new TerminalKeyDecoder();
    expect(decoder.push("\u001b[1;")).toEqual([]);
    expect(decoder.push("3D")).toEqual([{ type: "move-word-left" }]);
    expect(decoder.end()).toEqual([]);
  });

  test("turns bracketed paste into multiline input without submitting", () => {
    expect(decode("\u001b[20", "0~first\r\nsecond\u001b[201~")).toEqual([
      { type: "insert", text: "f" },
      { type: "insert", text: "i" },
      { type: "insert", text: "r" },
      { type: "insert", text: "s" },
      { type: "insert", text: "t" },
      { type: "newline" },
      { type: "insert", text: "s" },
      { type: "insert", text: "e" },
      { type: "insert", text: "c" },
      { type: "insert", text: "o" },
      { type: "insert", text: "n" },
      { type: "insert", text: "d" },
    ]);
  });

  test("maps Ctrl+C and raw Ctrl+D EOF to cancellation", () => {
    expect(decode("\u0003\u0004")).toEqual([{ type: "cancel" }, { type: "cancel" }]);
  });
});
