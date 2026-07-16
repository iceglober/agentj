import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { type ChatScreenCallbacks, createChatScreen } from "./chat-screen";
import { displayWidth } from "./terminal-editor";

class FakeInput extends PassThrough {
  isRaw = false;
  readonly rawModes: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

function makeScreen(
  over: Partial<ChatScreenCallbacks> = {},
  initialHistory: readonly string[] = [],
) {
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
    initialHistory,
    callbacks: {
      onSubmit: (text) => calls.submit.push(text),
      onTab: () => (calls.tab += 1),
      onEscape: () => (calls.escape += 1),
      onQuit: () => (calls.quit += 1),
      ...over,
    },
  });
  return { screen, input, output, calls, text: () => Buffer.concat(chunks).toString("utf8") };
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

  test("submits multiline input without collapsing internal blank lines", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("  first\u001b[13;2u\u001b[13;2u\u001b[13;2u\u001b[13;2usecond  \r");
    await settle();
    expect(calls.submit).toEqual(["  first\n\n\n\nsecond  "]);
    screen.stop();
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

  test("permission asks show the complete request and distinguish once, always, and deny", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const detail = `git push origin a-very-long-branch-name-that-exceeds-the-terminal-width\necho done`;
    const first = screen.askPermission({ tool: "bash", kind: "bash", detail });
    await settle();
    expect(text()).toContain(`Permission bash:\r\n${detail.replace("\n", "\r\n")}`);
    expect(text()).toContain("Permission bash — review request above");
    input.write("y");
    await expect(first).resolves.toBe("allow");

    const second = screen.askPermission({ tool: "edit", kind: "edit", detail: "src/a.ts" });
    input.write("x"); // ignored — not an answer key
    input.write("a");
    await expect(second).resolves.toBe("always");

    const third = screen.askPermission({ tool: "bash", kind: "bash", detail: "curl example.com" });
    input.write("n");
    await expect(third).resolves.toBe("deny");
    screen.stop();
  });

  test("escapes terminal controls in transcript and permission output", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    screen.printAbove("unsafe \u001b[2J output");
    const ask = screen.askPermission({
      tool: "bash",
      kind: "bash",
      detail: "printf '\u001b[31mred'\u202e",
    });
    await settle();
    expect(text()).toContain("unsafe \\x1b[2J output");
    expect(text()).toContain("printf '\\x1b[31mred'\\u{202e}");
    screen.stop();
    await expect(ask).resolves.toBe("deny");
  });

  test("queues concurrent permission asks and denies pending asks on stop", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const first = screen.askPermission({ tool: "bash", kind: "bash", detail: "first command" });
    const second = screen.askPermission({ tool: "edit", kind: "edit", detail: "second path" });
    await settle();
    const beforeAnswer = text();
    expect(beforeAnswer).toContain("first command");
    expect(beforeAnswer).not.toContain("second path");

    input.write("y");
    await expect(first).resolves.toBe("allow");
    await settle();
    expect(text()).toContain("second path");
    screen.stop();
    await expect(second).resolves.toBe("deny");
  });

  test("recalls submitted prompts with arrows and Ctrl+P/N from an empty editor", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("first\rsecond\r");
    await settle();

    input.write("\u001b[A\r");
    input.write("\u0010\r");
    input.write("\u0010\u0010\u000e\r");
    await settle();
    expect(calls.submit).toEqual(["first", "second", "second", "second", "second"]);
    screen.stop();
  });

  test("recalls persisted prompts supplied by a previous session", async () => {
    const { screen, input, calls } = makeScreen({}, ["oldest", "middle\nwith two lines", "newest"]);
    screen.start();
    input.write("\u001b[A\u001b[A\r");
    await settle();
    expect(calls.submit).toEqual(["middle\nwith two lines"]);
    screen.stop();
  });

  test("keeps Up/Down as multiline cursor movement outside history browsing", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("one\u001b[13;2utwo\u001b[AX\r");
    await settle();
    expect(calls.submit).toEqual(["oneX\ntwo"]);
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


  test("printAbove sanitizes by default; preStyled preserves trusted ANSI", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    // Untrusted content: a raw ESC must be neutralized to visible text.
    screen.printAbove("evil \u001b[2J payload");
    expect(text()).toContain("\\x1b[2J");
    // Trusted styled line (caller sanitized its interpolations) passes through.
    screen.printAbove("\u001b[1mstyled\u001b[0m", { preStyled: true });
    expect(text()).toContain("\u001b[1mstyled\u001b[0m");
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

  test("repaints on resize and keeps every live line within the new width", () => {
    const { screen, output, text } = makeScreen();
    screen.start();
    screen.setStatus("⏵ build · a deliberately long status");
    screen.setProgressLines(["t1 ◐ a deliberately long progress description"]);
    const beforeResize = text().length;

    output.columns = 14;
    output.emit("resize");
    const repaint = text().slice(beforeResize);
    const body = repaint.slice(repaint.indexOf("\u001b[J") + 3);
    const lines = body.split("\r\n");
    const finalLine = lines.pop()?.split("\r")[0] ?? "";
    lines.push(finalLine);
    expect(lines.every((line) => displayWidth(line) <= 13)).toBe(true);
    expect(repaint).toContain("…");

    screen.stop();
    const afterStop = text().length;
    output.emit("resize");
    expect(text()).toHaveLength(afterStop);
  });
});
