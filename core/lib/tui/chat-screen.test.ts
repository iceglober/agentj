import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { completeChatInput, suggestChatCommands } from "../chat/commands";
import { createAnsiLiveRegionAdapter } from "./ansi-live-region-adapter";
import {
  type ChatScreenCallbacks,
  type CreateChatScreenOptions,
  createChatScreen,
} from "./chat-screen";
import { createEditorCompletionProvider, findEditorToken } from "./editor-completion";
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
  screenOptions: Partial<
    Pick<
      CreateChatScreenOptions,
      "editorCompletionOptions" | "matchesSlashCommand" | "shouldRememberInput"
    > & {
      terminalHeight?: number;
      terminalWidth?: number;
      color?: boolean;
    }
  > = {},
) {
  const input = new FakeInput();
  const output = new PassThrough() as PassThrough & { columns: number; isTTY?: boolean };
  output.columns = 60;
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const calls = { submit: [] as string[], tab: 0, escape: 0, quit: 0 };
  const { terminalHeight, terminalWidth, color, ...chatScreenOptions } = screenOptions;
  output.isTTY = color ?? true;
  const screen = createChatScreen({
    stdin: input,
    liveRegion: createAnsiLiveRegionAdapter({ stdout: output, terminalHeight, terminalWidth }),
    escapeFlushMs: 5,
    quitWindowMs: 100,
    initialHistory,
    matchesSlashCommand: (query) => suggestChatCommands(query).length > 0,
    editorCompletionOptions: (state) => {
      const token = findEditorToken(state);
      if (token?.sigil !== "/" || token.start !== state.text.search(/\S/u)) return null;
      return {
        token,
        suggestions: suggestChatCommands(token.query).map(({ name, summary }) => ({
          value: `/${name} `,
          label: `/${name}`,
          summary,
        })),
      };
    },
    ...chatScreenOptions,
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
function renderScreen(stream: string, height = Number.POSITIVE_INFINITY): string[] {
  const rows: string[][] = Number.isFinite(height)
    ? Array.from({ length: height }, () => [])
    : [[]];
  let row = 0;
  let col = 0;
  const ensureRow = (target: number): void => {
    while (rows.length <= target) rows.push([]);
  };
  const lineFeed = (): void => {
    if (Number.isFinite(height) && row >= height - 1) {
      rows.shift();
      rows.push([]);
      row = height - 1;
    } else {
      row += 1;
      ensureRow(row);
    }
    col = 0;
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing ANSI escapes is the point
  const pattern = /\u001b\[([0-9;?]*)([A-Za-z])|([\s\S])/g;
  for (const match of stream.matchAll(pattern)) {
    const [, params, command, char] = match;
    if (command) {
      const values = params.replace("?", "").split(";").filter(Boolean).map(Number);
      const n = values[0] ?? 1;
      if (command === "A") row = Math.max(0, row - n);
      else if (command === "B") row += n;
      else if (command === "C") col += n;
      else if (command === "H") {
        row = Math.max(0, (values[0] ?? 1) - 1);
        col = Math.max(0, (values[1] ?? 1) - 1);
        ensureRow(row);
      } else if (command === "J") {
        ensureRow(row);
        rows[row] = (rows[row] ?? []).slice(0, col);
        if (Number.isFinite(height)) {
          for (let index = row + 1; index < height; index += 1) rows[index] = [];
        } else rows.length = row + 1;
      }
      continue;
    }
    if (char === "\r") col = 0;
    else if (char === "\n") lineFeed();
    else if (char !== undefined) {
      ensureRow(row);
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

  test("keeps unwrapped and bracketed multiline pastes in the editor until Return", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();

    input.write("first\nsecond\r\nthird");
    await settle();
    expect(calls.submit).toEqual([]);
    input.write("\r");
    await settle();
    expect(calls.submit).toEqual(["first\nsecond\nthird"]);

    input.write("\u001b[200~fourth\r");
    input.write("\nfifth\u001b[201~");
    await settle();
    expect(calls.submit).toHaveLength(1);
    input.write("\r");
    await settle();
    expect(calls.submit).toEqual(["first\nsecond\nthird", "fourth\nfifth"]);
    screen.stop();
  });

  test("large pastes collapse to a placeholder and expand on submit", async () => {
    const big = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
    const { screen, input, calls, text } = makeScreen();
    screen.start();
    input.write(`\u001b[200~${big}\u001b[201~`);
    await settle();
    const shown = renderScreen(text()).join("\n");
    expect(shown).toContain("[pasted content #1:");
    expect(shown).not.toContain("line-39");

    input.write(" trailing\r");
    await settle();
    expect(calls.submit).toEqual([`${big} trailing`]);
    screen.stop();
  });

  test("small pastes land verbatim in the editor, no placeholder", async () => {
    const { screen, input, calls, text } = makeScreen();
    screen.start();
    input.write("\u001b[200~alpha\nbeta\u001b[201~\r");
    await settle();
    expect(calls.submit).toEqual(["alpha\nbeta"]);
    expect(renderScreen(text()).join("\n")).not.toContain("[pasted content");
    screen.stop();
  });

  test("a live region taller than the viewport clamps so repaints stay in place", async () => {
    const { screen, input, text } = makeScreen({}, [], { terminalHeight: 8 });
    screen.start();
    const rows = Array.from({ length: 20 }, (_, i) => `row-${String(i).padStart(2, "0")}`);
    input.write(rows.join("\u001b[13;2u"));
    await settle();
    const rendered = renderScreen(text(), 8);
    expect(rendered.join("\n")).toContain("row-19");
    expect(rendered.join("\n")).not.toContain("row-00");
    expect(rendered.filter((line) => line.length > 0).length).toBeLessThanOrEqual(8);
    screen.stop();
  });

  test("restores a dequeued prompt ahead of a draft and focuses it for editing", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("existing draft");
    screen.restoreInput("queued\nprompt");
    input.write(" updated\r");
    await settle();
    expect(calls.submit).toEqual(["queued\nprompt updated\n\nexisting draft"]);
    screen.stop();
  });

  test("pastes copied file references in key order", async () => {
    let resolveFiles: ((value: string | null) => void) | undefined;
    const files = new Promise<string | null>((resolve) => {
      resolveFiles = resolve;
    });
    const { screen, input, calls } = makeScreen({ onPasteFiles: () => files });
    screen.start();
    input.write("before\u0016after\r");
    await settle();
    expect(calls.submit).toEqual([]);
    resolveFiles?.(' @"my notes.md" @src/main.ts ');
    await settle();
    expect(calls.submit).toEqual(['before @"my notes.md" @src/main.ts after']);
    screen.stop();
  });

  test("recovers queued input when file paste fails", async () => {
    const { screen, input, calls } = makeScreen({
      onPasteFiles: async () => {
        throw new Error("clipboard unavailable");
      },
    });
    screen.start();
    input.write("\u0016after\r");
    await settle();
    expect(calls.submit).toEqual(["after"]);
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

  test("shows and fuzzy-completes slash commands before mode toggling", async () => {
    const { screen, input, calls, text } = makeScreen();
    screen.start();
    input.write("/");
    await settle();
    const shown = renderScreen(text()).join("\n");
    expect(shown).toContain("› /help — List commands and keys");
    expect(shown).toContain("/activity — Show completed tool activity for this session");
    expect(shown).toContain("… ↓ 7 more");

    input.write("bld\t\r");
    await settle();
    expect(calls.tab).toBe(0);
    expect(calls.submit).toEqual(["/build "]);
    screen.stop();
  });

  test("shows next-argument options after accepting an advancing completion", async () => {
    const { screen, input, calls, text } = makeScreen({}, [], {
      editorCompletionOptions: (state) => completeChatInput(state.text, state.cursor),
    });
    screen.start();

    input.write("/con\t");
    await settle();
    let shown = renderScreen(text()).join("\n");
    expect(shown).toContain("> /config ");
    expect(shown).toContain("› get — Read a global configuration value");
    expect(shown).toContain("set — Set a global configuration value");

    input.write("s\t");
    await settle();
    shown = renderScreen(text()).join("\n");
    expect(shown).toContain("> /config set ");
    expect(shown).toContain("agent.llm.model — Model name");
    expect(calls.tab).toBe(0);
    expect(calls.submit).toEqual([]);
    screen.stop();
  });

  test("replaces a nested token and renders its contextual hint", async () => {
    const seen: Array<{ text: string; cursor: number }> = [];
    const { screen, input, calls, text } = makeScreen({}, [], {
      editorCompletionOptions: (state) => {
        seen.push({ text: state.text, cursor: state.cursor });
        if (!state.text.startsWith("/config set ")) return null;
        return {
          token: { start: 12, end: state.text.length },
          suggestions: [
            { value: "dark", label: "dark theme", summary: "Use dark colors" },
            { value: "light", summary: "Use light colors" },
          ],
          hint: "Choose the nested theme value",
        };
      },
    });
    screen.start();
    input.write("/config set da");
    await settle();
    const shown = renderScreen(text()).join("\n");
    expect(shown).toContain("› dark theme — Use dark colors");
    expect(shown).toContain("Choose the nested theme value");
    expect(seen.at(-1)).toEqual({ text: "/config set da", cursor: 14 });

    input.write("\t\r/config set x\u001b[B\r\r");
    await settle();
    expect(calls.submit).toEqual(["/config set dark", "/config set light"]);
    screen.stop();
  });

  test("long completion lists scroll with the selection instead of truncating", async () => {
    const values = Array.from(
      { length: 20 },
      (_, i) => `agent.param.${String(i).padStart(2, "0")}`,
    );
    const { screen, input, calls, text } = makeScreen({}, [], {
      editorCompletionOptions: (state) => {
        if (!state.text.startsWith("/config set")) return null;
        return {
          token: { start: 12, end: state.text.length },
          suggestions: values.map((value) => ({ value, summary: "Configuration value" })),
          hint: "Choose a configuration path.",
        };
      },
    });
    screen.start();
    input.write("/config set ");
    await settle();
    let rendered = renderScreen(text());
    let shown = rendered.join("\n");
    const rowsAtTop = rendered.length;
    expect(shown).toContain("› agent.param.00");
    expect(shown).toContain("… ↓ 13 more");
    expect(shown).not.toContain("agent.param.10");

    // Ten arrow-downs: the window follows the selection past the old cutoff,
    // and the single footer row keeps the menu height fixed while scrolling.
    input.write("[B".repeat(10));
    await settle();
    rendered = renderScreen(text());
    shown = rendered.join("\n");
    expect(shown).toContain("› agent.param.10");
    expect(shown).toContain("… ↑ 7 · ↓ 6 more");
    expect(rendered.length).toBe(rowsAtTop);

    // The selected item beyond the visible cap is genuinely acceptable.
    input.write("\t\r");
    await settle();
    expect(calls.submit).toEqual(["/config set agent.param.10"]);
    screen.stop();
  });

  test("guided-input differentiates choice labels and descriptions", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const answer = screen.askInput({
      label: "Pick one",
      choices: [
        { label: "CLI", value: "cli", description: "Change the command-line interface." },
        { label: "TUI", value: "tui", description: "Change the terminal interface." },
      ],
    });
    await settle();
    const shown = renderScreen(text()).join("\n");
    expect(shown).toContain("CLI");
    expect(shown).toContain("Change the command-line interface.");
    expect(text()).toContain("\u001b[1m\u001b[36m›\u001b[0m");
    expect(text()).toContain("\u001b[1mCLI\u001b[0m");
    expect(text()).toContain("\u001b[2mChange the command-line interface.\u001b[0m");
    input.write("\r");
    await expect(answer).resolves.toBe("cli");
    screen.stop();
  });

  test("guided-input choice styling stays plain when color is disabled", async () => {
    const { screen, input, text } = makeScreen({}, [], { color: false });
    screen.start();
    const answer = screen.askInput({
      label: "Pick one",
      choices: [{ label: "CLI", value: "cli", description: "Change the command-line interface." }],
    });
    await settle();
    expect(text()).not.toContain("\u001b[1m");
    expect(text()).not.toContain("\u001b[2m");
    input.write("\r");
    await expect(answer).resolves.toBe("cli");
    screen.stop();
  });

  test("guided-input choices beyond the window stay reachable and visible", async () => {
    const choices = Array.from({ length: 12 }, (_, i) => `choice-${String(i).padStart(2, "0")}`);
    const { screen, input, text } = makeScreen();
    screen.start();
    const answer = screen.askInput({ label: "Pick one", choices });
    input.write("[B".repeat(9)); // move to choice-09, past the old 7-row cutoff
    await settle();
    const shown = renderScreen(text()).join("\n");
    expect(shown).toContain("› choice-09");
    expect(shown).toContain("… ↑");
    input.write("\r");
    await expect(answer).resolves.toBe("choice-09");
    screen.stop();
  });

  test("navigates suggestions and lets exact commands submit immediately", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("/\u001b[B\r\r/help\r");
    await settle();
    expect(calls.submit).toEqual(["/mcp ", "/help"]);
    screen.stop();
  });

  test("completes a slash inserted at the start of existing input but ignores inline slashes", async () => {
    const { screen, input, calls } = makeScreen();
    screen.start();
    input.write("jobs\u0001/\t\r");
    input.write("say /b\t");
    await settle();
    expect(calls.submit).toEqual(["/jobs "]);
    expect(calls.tab).toBe(1);
    screen.stop();
  });

  test("completes inline slash and @ tokens through one provider", async () => {
    const { screen, input, calls } = makeScreen({}, [], {
      editorCompletionOptions: createEditorCompletionProvider({
        completeInitialSlash: (state) => completeChatInput(state.text, state.cursor),
        suggestInlineSlash: (query) =>
          query === "bld" ? [{ value: "/build ", label: "/build", summary: "Build mode" }] : [],
        suggestFiles: (query) =>
          query === "src"
            ? [{ value: "@src/main.ts", label: "@src/main.ts", summary: "Project file" }]
            : [],
      }),
    });
    screen.start();
    input.write("review /bld\t @src\t\r");
    await settle();
    expect(calls.submit).toEqual(["review /build  @src/main.ts"]);
    screen.stop();
  });

  test("shows a background-job cue only for a leading ampersand", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    input.write("& run tests");
    await settle();
    expect(renderScreen(text()).join("\n")).toContain("BACKGROUND JOB");
    screen.stop();
  });

  test("Escape dismisses command suggestions before interrupting", async () => {
    const { screen, input, calls, text } = makeScreen();
    screen.start();
    input.write("/");
    input.write("\u001b");
    await settle();
    expect(calls.escape).toBe(0);
    expect(renderScreen(text()).join("\n")).not.toContain("List commands and keys");
    input.write("\t");
    await settle();
    expect(calls.tab).toBe(1);
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

  test("permission asks show the request inside the modal and distinguish once, always, and deny", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const detail = `git push origin a-very-long-branch-name-that-exceeds-the-terminal-width\necho done`;
    const first = screen.askPermission({ tool: "bash", kind: "bash", detail });
    await settle();
    // The command renders in the modal itself — wrapped, indented — without a
    // duplicate transcript copy for a request this short.
    expect(text()).toContain("Permission bash\r\n  git push origin");
    expect(renderScreen(text()).join("\n")).toContain(
      "<Y> allow once · <A> always this session · <N> deny",
    );
    expect(text()).toContain("  echo done");
    expect(text()).not.toContain("Permission bash:");
    expect(text()).not.toContain("review request above");
    input.write("y");
    await expect(first).resolves.toBe("allow");

    // A request beyond the modal clamp keeps a full transcript copy and says
    // how much the modal omitted.
    const longDetail = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
    const long = screen.askPermission({ tool: "bash", kind: "bash", detail: longDetail });
    await settle();
    expect(text()).toContain(`Permission bash:\r\n${longDetail.split("\n").join("\r\n")}`);
    expect(text()).toContain("… +6 more lines");
    input.write("n");
    await expect(long).resolves.toBe("deny");

    const second = screen.askPermission({ tool: "edit", kind: "edit", detail: "src/a.ts" });
    input.write("x"); // ignored — not an answer key
    input.write("a");
    await expect(second).resolves.toBe("always");

    const third = screen.askPermission({ tool: "bash", kind: "bash", detail: "curl example.com" });
    input.write("n");
    await expect(third).resolves.toBe("deny");

    // Child-agent asks carry their origin into the modal heading.
    const child = screen.askPermission({
      tool: "bash",
      kind: "bash",
      detail: "git push",
      origin: "subagent t2",
    });
    await settle();
    expect(text()).toContain("Permission bash — subagent t2");
    input.write("n");
    await expect(child).resolves.toBe("deny");
    screen.stop();
  });

  test("permission keycaps wrap into clear choices on narrow terminals", async () => {
    const { screen, input, text } = makeScreen({}, [], { terminalWidth: 35 });
    screen.start();
    const ask = screen.askPermission({ tool: "bash", kind: "bash", detail: "git push" });
    await settle();
    const rendered = renderScreen(text()).join("\n");
    expect(rendered).toContain("<Y> allow once");
    expect(rendered).toContain("<A> always this session");
    expect(rendered).toContain("<N> deny");
    input.write("n");
    await expect(ask).resolves.toBe("deny");
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

  test("masks modal input without submitting or retaining it", async () => {
    const { screen, input, calls, text } = makeScreen({}, ["remembered"]);
    screen.start();
    const secret = screen.askInput({ label: "API key", masked: true });
    input.write("s3cret");
    await settle();
    const shown = renderScreen(text()).join("\n");
    expect(shown).toContain("API key");
    expect(shown).toContain("••••••");
    expect(text()).not.toContain("s3cret");
    input.write("\r");
    await expect(secret).resolves.toBe("s3cret");
    expect(calls.submit).toEqual([]);

    input.write("\u001b[A\r");
    await settle();
    expect(calls.submit).toEqual(["remembered"]);
    screen.stop();
  });

  test("keeps invalid modal input open and cancels with Escape", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const answer = screen.askInput({
      label: "Profile name",
      choices: ["work", "personal"],
      validate: (value) => (value.length < 4 ? "Enter at least four characters" : null),
    });
    input.write("x\r");
    await settle();
    expect(renderScreen(text()).join("\n")).toContain("Enter at least four characters");
    input.write("\u0001\u000bwork\r");
    await expect(answer).resolves.toBe("work");

    const cancelled = screen.askInput({ label: "Optional value" });
    input.write("ignored\u001b");
    await settle();
    await expect(cancelled).resolves.toBeNull();
    screen.stop();
  });

  test("serializes input prompts with permission prompts", async () => {
    const { screen, input, text } = makeScreen();
    screen.start();
    const answer = screen.askInput({ label: "First value" });
    const permission = screen.askPermission({ tool: "bash", kind: "bash", detail: "echo queued" });
    await settle();
    expect(renderScreen(text()).join("\n")).toContain("First value");
    expect(text()).not.toContain("echo queued");
    input.write("done\r");
    await expect(answer).resolves.toBe("done");
    await settle();
    expect(text()).toContain("echo queued");
    input.write("y");
    await expect(permission).resolves.toBe("allow");
    screen.stop();
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

  test("can exclude sensitive submitted commands from in-memory history", async () => {
    const { screen, input, calls } = makeScreen({}, ["old", "/config set persisted-secret"], {
      shouldRememberInput: (text) => !text.startsWith("/config set "),
    });
    screen.start();
    input.write("\u001b[A\rsafe\r/config set secret\r");
    await settle();
    input.write("\u001b[A\r");
    await settle();
    expect(calls.submit).toEqual(["old", "safe", "/config set secret", "safe"]);
    screen.stop();
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
    for (let i = 0; i < 5; i += 1) screen.setStatusLines([`status ${i}`]);
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

  test("printAbove sanitizes text and styles only semantic spans", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    screen.printAbove("evil \u001b[2J payload");
    expect(text()).toContain("\\x1b[2J");
    screen.printAbove([[{ text: "styled", tone: "accent", bold: true }]]);
    expect(text()).toContain("\u001b[1m\u001b[36mstyled\u001b[0m");
    screen.stop();
  });

  test("keeps one blank transcript row and separates todo, activity, and thinking lines", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    screen.printAbove("earlier transcript item");
    screen.printAbove("latest transcript item");
    await settle();

    let rendered = renderScreen(text());
    const earlier = rendered.findIndex((line) => line.includes("earlier transcript item"));
    const latest = rendered.findIndex((line) => line.includes("latest transcript item"));
    const idleEditor = rendered.findIndex((line) => line.startsWith("> "));
    expect(rendered.slice(earlier, latest + 1)).toEqual([
      "earlier transcript item",
      "",
      "latest transcript item",
    ]);
    expect(rendered.slice(latest + 1, idleEditor)).toEqual(["", ""]);

    screen.setProgressLines([
      "  ◐ tool running",
      "",
      "  ╭─ Todos 0/1 done · 1 active",
      "  ╰────────────────────────────",
    ]);
    screen.setThinkingLine("◐ thinking 1s (esc)");
    await settle();
    rendered = renderScreen(text());
    const todo = rendered.findIndex((line) => line.includes("Todos 0/1 done"));
    const tool = rendered.findIndex((line) => line.includes("tool running"));
    const thinking = rendered.findIndex((line) => line.includes("thinking 1s"));
    const activeEditor = rendered.findIndex((line) => line.startsWith("> "));
    expect(tool).toBeLessThan(todo);
    expect(rendered.slice(tool + 1, todo)).toEqual([""]);
    expect(todo).toBeLessThan(thinking);
    expect(thinking).toBe(activeEditor - 1);
    screen.stop();
  });

  test("clears rendered transcript and repaints the live editor", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    screen.printAbove("old transcript");
    screen.setStatusLines(["old status"]);
    await settle();
    const before = text().length;

    screen.clearTranscript();
    const cleared = text().slice(before);
    expect(cleared).toContain("\u001b[2J\u001b[H");
    expect(renderScreen(cleared).some((line) => line.includes("old transcript"))).toBe(false);
    expect(renderScreen(cleared).some((line) => line.includes("old status"))).toBe(false);
    expect(renderScreen(cleared).some((line) => line.startsWith("> "))).toBe(true);
    screen.stop();
  });

  test("status and progress lines render in the live region", async () => {
    const { screen, text } = makeScreen();
    screen.start();
    screen.setStatusLines(["204ed50c · build", "~/repos/demo"]);
    screen.setProgressLines(["t1 ◐ mapping modules"]);
    await settle();
    expect(text()).toContain("204ed50c · build");
    expect(text()).toContain("~/repos/demo");
    expect(text()).toContain("t1 ◐ mapping modules");
    screen.stop();
  });

  test("repaints on resize and keeps every live line within the new width", () => {
    const { screen, output, text } = makeScreen();
    screen.start();
    screen.setStatusLines(["⏵ build · a deliberately long status"]);
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
