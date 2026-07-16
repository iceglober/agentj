import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { type ChatScreenCallbacks, createChatScreen } from "./chat-screen";

class FakeInput extends PassThrough {
  isRaw = false;
  readonly rawModes: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

function makeScreen(over: Partial<ChatScreenCallbacks> = {}) {
  const input = new FakeInput();
  const output = new PassThrough() as PassThrough & { columns: number };
  output.columns = 60;
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const calls = { submit: [] as string[], tab: 0, escape: 0, quit: 0 };
  const screen = createChatScreen({
    stdin: input,
    stdout: output,
    escapeFlushMs: 5,
    quitWindowMs: 100,
    callbacks: {
      onSubmit: (text) => calls.submit.push(text),
      onTab: () => (calls.tab += 1),
      onEscape: () => (calls.escape += 1),
      onQuit: () => (calls.quit += 1),
      ...over,
    },
  });
  return { screen, input, calls, text: () => Buffer.concat(chunks).toString("utf8") };
}

/**
 * Minimal virtual terminal: interprets the screen's ANSI output (CR, LF,
 * cursor up/forward, ESC[J clear-down) so tests can assert what actually
 * survives on screen — presence-in-stream assertions cannot catch repaint
 * arithmetic bugs that eat lines above the live region.
 */
function renderScreen(stream: string): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing ANSI escapes is the point
  const pattern = /\u001b\[([0-9]*)([A-Za-z])|([\s\S])/g;
  for (const match of stream.matchAll(pattern)) {
    const [, count, command, char] = match;
    if (command) {
      const n = count === "" || count === undefined ? 1 : Number(count);
      if (command === "A") row = Math.max(0, row - n);
      else if (command === "B") row += n;
      else if (command === "C") col += n;
      else if (command === "J") {
        rows[row] = (rows[row] ?? []).slice(0, col);
        rows.length = row + 1;
      }
      continue;
    }
    if (char === "\r") col = 0;
    else if (char === "\n") {
      row += 1;
      col = 0;
      while (rows.length <= row) rows.push([]);
    } else if (char !== undefined) {
      while (rows.length <= row) rows.push([]);
      const line = rows[row] ?? [];
      while (line.length < col) line.push(" ");
      line[col] = char;
      rows[row] = line;
      col += 1;
    }
  }
  return rows.map((line) => line.join(""));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("createChatScreen", () => {
  test("types into the live editor, submits on Enter, and clears the editor", async () => {
    const { screen, input, calls, text } = makeScreen();
    screen.start();
    input.write("hello there\r");
    await settle();
    expect(calls.submit).toEqual(["hello there"]);
    expect(text()).toContain("hello there");
    screen.stop();
    expect(input.rawModes).toEqual([true, false]);
  });

  test("Tab toggles mode, bare Escape flushes to an interrupt", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("\t");
    await settle();
    expect(calls.tab).toBe(1);
    input.write("\u001b"); // bare ESC — resolves via the flush timer
    await settle();
    expect(calls.escape).toBe(1);
    // ESC followed quickly by an arrow is a normal editor sequence, not an interrupt.
    input.write("\u001b");
    input.write("[D");
    await settle();
    expect(calls.escape).toBe(1);
    screen.stop();
  });

  test("Ctrl+C clears a non-empty editor, interrupts when empty, quits on double press", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("draft text");
    input.write("\u0003"); // clears editor
    await settle();
    expect(calls.escape).toBe(0);
    input.write("\u0003"); // empty → interrupt + arm quit
    await settle();
    expect(calls.escape).toBe(1);
    input.write("\u0003"); // within window → quit
    await settle();
    expect(calls.quit).toBe(1);
    screen.stop();
  });

  test("printAbove keeps transcript above the repainted live region", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    input.write("typing");
    await settle();
    screen.printAbove("Assistant: done with the thing");
    const output = text();
    expect(output).toContain("Assistant: done with the thing");
    // The live region (editor content) is repainted after the transcript line.
    expect(output.lastIndexOf("typing")).toBeGreaterThan(
      output.lastIndexOf("Assistant: done with the thing"),
    );
    screen.stop();
  });

  test("permission asks are modal: y allows, n denies, editor input is suspended", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const first = screen.askPermission({ tool: "bash", kind: "bash", detail: "git push" });
    await settle();
    expect(text()).toContain("Permission bash: git push");
    input.write("y");
    await expect(first).resolves.toBe("allow");

    const second = screen.askPermission({ tool: "edit", kind: "edit", detail: "src/a.ts" });
    input.write("x"); // ignored — not an answer key
    input.write("n");
    await expect(second).resolves.toBe("deny");
    screen.stop();
  });

  test("repaints never climb above the live region (shell history survives)", async () => {
    const { screen, input, text } = makeScreen();
    // Pre-existing shell history above where the screen starts painting.
    const output = text; // capture closure
    void output;
    screen.start();
    screen.printAbove("shell-history-1");
    screen.printAbove("shell-history-2");
    // Many repaints: typing, Tab-driven status updates, progress churn.
    input.write("hello");
    await settle();
    for (let i = 0; i < 5; i += 1) screen.setStatus(`status ${i}`);
    screen.setProgressLines(["  · t1 working"]);
    screen.setProgressLines([]);
    input.write(" world");
    await settle();

    const rows = renderScreen(text());
    const joined = rows.join("\n");
    expect(joined).toContain("shell-history-1");
    expect(joined).toContain("shell-history-2");
    // History stays ABOVE the live region, in order.
    expect(joined.indexOf("shell-history-1")).toBeLessThan(joined.indexOf("shell-history-2"));
    expect(joined.indexOf("shell-history-2")).toBeLessThan(joined.indexOf("> hello world"));
    screen.stop();
  });

  test("status and progress lines render in the live region", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    screen.setStatus("⏵ build · 1 job");
    screen.setProgressLines(["t1 ◐ mapping modules"]);
    await settle();
    expect(text()).toContain("⏵ build · 1 job");
    expect(text()).toContain("t1 ◐ mapping modules");
    screen.stop();
  });
});
