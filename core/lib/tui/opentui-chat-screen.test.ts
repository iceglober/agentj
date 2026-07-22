import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ChatScreenCallbacks } from "./chat-screen";
import {
  type CreateOpenTuiChatScreenOptions,
  createOpenTuiChatScreen,
} from "./opentui-chat-screen";

type Overrides = Partial<Omit<CreateOpenTuiChatScreenOptions, "callbacks">> & {
  callbacks?: Partial<ChatScreenCallbacks>;
};

const setup = async (overrides: Overrides = {}) => {
  const harness = await createTestRenderer({
    width: 80,
    height: 24,
    screenMode: "alternate-screen",
  });
  const submitted: string[] = [];
  const { callbacks: callbackOverrides, ...rest } = overrides;
  const screen = await createOpenTuiChatScreen({
    renderer: harness.renderer,
    color: false,
    matchesSlashCommand: () => false,
    ...rest,
    callbacks: {
      onSubmit: (text) => submitted.push(text),
      onTab: () => {},
      onEscape: () => {},
      onQuit: () => {},
      ...callbackOverrides,
    },
  });
  return { ...harness, screen, submitted };
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("createOpenTuiChatScreen", () => {
  test("start and stop run without throwing", async () => {
    const { renderer, screen } = await setup();
    expect(() => screen.start()).not.toThrow();
    expect(() => screen.stop()).not.toThrow();
    renderer.destroy();
  });

  test("printAbove renders a transcript block", async () => {
    const { renderer, screen, renderOnce, captureCharFrame } = await setup();
    screen.start();
    screen.printAbove([[{ text: "hello transcript" }]]);
    await renderOnce();
    expect(captureCharFrame()).toContain("hello transcript");
    screen.stop();
    renderer.destroy();
  });

  test("setStatusLines and setPresenceLine update the surface", async () => {
    const { renderer, screen, renderOnce, captureCharFrame } = await setup();
    screen.start();
    screen.setPresenceLine("● Thinking");
    screen.setStatusLines([[{ text: "status footer" }]]);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Thinking");
    expect(frame).toContain("status footer");
    screen.stop();
    renderer.destroy();
  });

  test("a submitted line fires onSubmit and clears the composer", async () => {
    const { renderer, screen, mockInput, renderOnce, captureCharFrame, submitted } = await setup();
    // Start the renderer so mock keystrokes reach the focused composer.
    renderer.start();
    screen.start();
    await mockInput.typeText("hi there");
    await renderOnce();
    mockInput.pressEnter();
    await waitUntil(() => submitted.length > 0);
    expect(submitted).toEqual(["hi there"]);
    await renderOnce();
    expect(captureCharFrame()).not.toContain("hi there");
    screen.stop();
    renderer.destroy();
  });

  test("completion overlay keeps the composer visible", async () => {
    const { renderer, screen, mockInput, renderOnce, captureCharFrame } = await setup({
      matchesSlashCommand: () => true,
      editorCompletionOptions: ({ text, cursor }) =>
        text.startsWith("/")
          ? {
              token: { start: 0, end: cursor, sigil: "/", query: text.slice(1) },
              suggestions: [{ value: "/model ", label: "/model" }],
            }
          : null,
    });
    renderer.start();
    screen.start();
    await mockInput.typeText("/m");
    await renderOnce();
    const lines = captureCharFrame()
      .split("\n")
      .map((line) => line.replace(/\s+$/u, ""));
    // The suggestion renders...
    expect(lines.some((line) => line.includes("/model"))).toBe(true);
    // ...and the composer input line is NOT pushed off-screen by the overlay.
    expect(lines.some((line) => line.includes("›") && line.endsWith("/m"))).toBe(true);
    screen.stop();
    renderer.destroy();
  });

  test("Ctrl+V inserts the marker returned by onPasteFiles", async () => {
    const { renderer, screen, mockInput, captureCharFrame } = await setup({
      callbacks: { onPasteFiles: async () => " [file] " },
    });
    renderer.start();
    screen.start();
    mockInput.pressKey("v", { ctrl: true });
    await waitUntil(() => captureCharFrame().includes("[file]"));
    expect(captureCharFrame()).toContain("[file]");
    screen.stop();
    renderer.destroy();
  });

  test("copies a highlighted selection to the system clipboard", async () => {
    const { renderer, screen } = await setup();
    const copied: string[] = [];
    const spy = renderer as unknown as {
      copyToClipboardOSC52: (t: string) => boolean;
      emit: (event: string, ...args: unknown[]) => void;
    };
    spy.copyToClipboardOSC52 = (t) => {
      copied.push(t);
      return true;
    };
    screen.start();
    // OpenTUI draws the highlight and emits "selection"; the adapter copies it.
    spy.emit("selection", { getSelectedText: () => "grab me" });
    spy.emit("selection", { getSelectedText: () => "" }); // empty selection is ignored
    expect(copied).toEqual(["grab me"]);
    screen.stop();
    renderer.destroy();
  });
});
