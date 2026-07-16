import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createEditorState } from "./editor";
import { createTerminalPromptEditor, renderEditorLayout } from "./terminal-editor";

class FakeTerminalInput extends PassThrough {
  isRaw = false;
  readonly rawModes: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

const memoryOutput = (columns = 80) => {
  const output = new PassThrough() as PassThrough & { columns: number };
  output.columns = columns;
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { output, text: () => Buffer.concat(chunks).toString("utf8") };
};

const request = { message: "Enter a task" };

describe("terminal prompt editor", () => {
  test("renders, repaints multiline input, and submits Return", async () => {
    const input = new FakeTerminalInput();
    const { output, text } = memoryOutput();
    const editor = createTerminalPromptEditor({ stdin: input, stdout: output });

    const result = editor.read(request);
    input.write("first\u001b[13;2usecond\r");

    await expect(result).resolves.toBe("first\nsecond");
    expect(text()).toContain("Enter a task\n> ");
    expect(text()).toContain("first\r\nsecond");
    expect(text()).toContain("\u001b[J");
    expect(text().endsWith("\r\n")).toBe(true);
    expect(input.rawModes).toEqual([true, false]);
  });

  test("uses cursor commands while editing and leaves only completed text on submission", async () => {
    const input = new FakeTerminalInput();
    const { output } = memoryOutput();
    const editor = createTerminalPromptEditor({ stdin: input, stdout: output });

    const result = editor.read(request);
    input.write("ac\u001b[Db\r");
    await expect(result).resolves.toBe("abc");
  });

  test("returns null for Ctrl+C and EOF", async () => {
    const cancelledInput = new FakeTerminalInput();
    const cancelledOutput = memoryOutput();
    const editor = createTerminalPromptEditor({
      stdin: cancelledInput,
      stdout: cancelledOutput.output,
    });
    const cancelled = editor.read(request);
    cancelledInput.write("partial\u0003");
    await expect(cancelled).resolves.toBeNull();
    expect(cancelledInput.isRaw).toBe(false);

    const eofInput = new FakeTerminalInput();
    const eofOutput = memoryOutput();
    const eofEditor = createTerminalPromptEditor({ stdin: eofInput, stdout: eofOutput.output });
    const eof = eofEditor.read(request);
    eofInput.end();
    await expect(eof).resolves.toBeNull();
    expect(eofInput.isRaw).toBe(false);
  });

  test("supports repeated prompts without leaking listeners", async () => {
    const input = new FakeTerminalInput();
    input.pause();
    const { output } = memoryOutput();
    const editor = createTerminalPromptEditor({ stdin: input, stdout: output });

    const first = editor.read(request);
    input.write("one\r");
    await expect(first).resolves.toBe("one");
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);

    const second = editor.read(request);
    input.write("two\r");
    await expect(second).resolves.toBe("two");
    expect(input.rawModes).toEqual([true, false, true, false]);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("restores raw mode and listeners when the input stream errors", async () => {
    const input = new FakeTerminalInput();
    const { output } = memoryOutput();
    const editor = createTerminalPromptEditor({ stdin: input, stdout: output });

    const result = editor.read(request);
    input.emit("error", new Error("terminal failed"));
    await expect(result).rejects.toThrow("terminal failed");
    expect(input.isRaw).toBe(false);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });

  test("lays out wrapped and explicit multiline content at the active cursor", () => {
    expect(renderEditorLayout(createEditorState("123456789"), 10)).toEqual({
      rows: ["> 12345678", "9"],
      cursorRow: 1,
      cursorColumn: 1,
      finalColumn: 1,
    });
    expect(renderEditorLayout({ ...createEditorState("ab\ncdef"), cursor: 4 }, 20)).toMatchObject({
      rows: ["> ab", "cdef"],
      cursorRow: 1,
      cursorColumn: 1,
    });
  });

  test("sizes flag and VS-16 emoji two cells wide and legacy-computing symbols one", () => {
    expect(renderEditorLayout(createEditorState("🇺🇸"), 80).cursorColumn).toBe(4);
    expect(renderEditorLayout(createEditorState("❤️"), 80).cursorColumn).toBe(4);
    expect(renderEditorLayout(createEditorState("\u{1fb00}"), 80).cursorColumn).toBe(3);
  });
});
