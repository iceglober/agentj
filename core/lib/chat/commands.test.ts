import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ChatCommandContext,
  expandAtFiles,
  parseInput,
  runChatCommand,
  suggestChatCommands,
} from "./commands";
import type { ChatEvent } from "./events";
import type { JobRunner } from "./jobs";

describe("parseInput", () => {
  test("routes slash commands, & jobs, and plain messages", () => {
    expect(parseInput("/jobs abort j2")).toEqual({
      kind: "command",
      name: "jobs",
      args: "abort j2",
    });
    expect(parseInput("& refactor the tests")).toEqual({
      kind: "job",
      prompt: "refactor the tests",
    });
    expect(parseInput("  fix the bug  ")).toEqual({ kind: "message", text: "fix the bug" });
  });

  test("trims outer whitespace but preserves internal blank lines", () => {
    expect(parseInput(" \n\nfirst\n\n\n\nsecond\n\n ")).toEqual({
      kind: "message",
      text: "first\n\n\n\nsecond",
    });
  });
});

describe("suggestChatCommands", () => {
  test("returns registry order for an empty query and matches case-insensitively", () => {
    expect(suggestChatCommands("").map(({ name }) => name)).toEqual([
      "help",
      "build",
      "jobs",
      "undo",
      "redo",
      "clear",
      "quit",
    ]);
    expect(suggestChatCommands("BU")[0]?.name).toBe("build");
  });

  test("ranks exact and prefix matches before compact ordered subsequences", () => {
    expect(suggestChatCommands("redo")[0]?.name).toBe("redo");
    expect(suggestChatCommands("cl")[0]?.name).toBe("clear");
    expect(suggestChatCommands("bld").map(({ name }) => name)).toEqual(["build"]);
    expect(suggestChatCommands("ud")[0]?.name).toBe("undo");
    expect(suggestChatCommands("zzz")).toEqual([]);
  });
});

describe("expandAtFiles", () => {
  test("attaches referenced files bounded, leaves misses untouched", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "agentj-at-"));
    try {
      await writeFile(path.join(cwd, "notes.md"), "the notes content");
      const expanded = await expandAtFiles("look at @notes.md and @missing.md", cwd);
      expect(expanded).toContain("--- @notes.md ---");
      expect(expanded).toContain("the notes content");
      expect(expanded).not.toContain("--- @missing.md");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("runChatCommand", () => {
  function makeContext() {
    const events: ChatEvent[] = [];
    let quitCalls = 0;
    const aborted: string[] = [];
    const context: ChatCommandContext = {
      session: {} as ChatCommandContext["session"],
      jobs: {
        start: () => {
          throw new Error("not used");
        },
        list: () => [
          {
            id: "j1",
            mode: "plan",
            prompt: "research",
            status: "running",
            startedAt: 0,
          },
        ],
        abort: (id: string) => {
          aborted.push(id);
          return id === "j1";
        },
        dispose: () => {},
      } satisfies JobRunner,
      undo: {
        snapshot: async () => null,
        undo: async () => "turn 3",
        redo: async () => null,
        dispose: async () => {},
      },
      emit: (event) => {
        events.push(event);
      },
      quit: () => {
        quitCalls += 1;
      },
    };
    return { context, events, aborted, quitCalls: () => quitCalls };
  }

  test("help lists every registered command", async () => {
    const { context, events } = makeContext();
    await runChatCommand(context, "help", "");
    expect(events[0]).toEqual({ type: "command", name: "help" });
    const text = (events[1] as { text: string }).text;
    for (const name of ["/help", "/build", "/jobs", "/undo", "/redo", "/clear", "/quit"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("complete a shown command");
  });

  test("build switches mode before sending an implementation turn", async () => {
    const { context } = makeContext();
    const calls: string[] = [];
    context.session = {
      setMode: (mode) => {
        calls.push(`mode:${mode}`);
        return mode ?? "plan";
      },
      send: async (text, options) => {
        calls.push(`send:${options?.transcriptText}:${text}`);
      },
    } as ChatCommandContext["session"];

    await runChatCommand(context, "build", "");

    expect(calls).toEqual([
      "mode:build",
      "send:Command: build:Implement the work agreed on in this conversation, incorporating the plan, discussion, and user feedback. Complete and validate it end to end.",
    ]);
  });

  test("jobs lists and aborts; undo/redo report labels; unknown suggests help", async () => {
    const { context, events, aborted } = makeContext();
    await runChatCommand(context, "jobs", "");
    expect(events[0]).toEqual({ type: "command", name: "jobs" });
    expect((events.at(-1) as { text: string }).text).toContain("j1 [running]");

    await runChatCommand(context, "jobs", "abort j1");
    expect(aborted).toEqual(["j1"]);

    await runChatCommand(context, "undo", "");
    expect((events.at(-1) as { text: string }).text).toContain("turn 3");

    await runChatCommand(context, "redo", "");
    expect((events.at(-1) as { text: string }).text).toContain("Nothing to redo");

    await runChatCommand(context, "wat", "");
    expect((events.at(-1) as { text: string }).text).toContain("/help");
  });

  test("quit ends the session", async () => {
    const { context, quitCalls } = makeContext();
    await runChatCommand(context, "quit", "");
    expect(quitCalls()).toBe(1);
  });
});
