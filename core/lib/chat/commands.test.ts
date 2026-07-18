import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ChatCommandContext,
  completeChatInput,
  expandAtFiles,
  parseInput,
  runChatCommand,
  shouldRememberChatInput,
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
    expect(parseInput('/mcp set docs {\n  "label":"a  b"\n}')).toEqual({
      kind: "command",
      name: "mcp",
      args: 'set docs {\n  "label":"a  b"\n}',
    });
  });
});

describe("command history policy", () => {
  test("does not retain configuration payloads", () => {
    expect(
      shouldRememberChatInput('/config set mcp.servers.docs.headers.Authorization "secret"'),
    ).toBe(false);
    expect(shouldRememberChatInput('/mcp set docs {"headers":{"Authorization":"secret"}}')).toBe(
      false,
    );
    expect(shouldRememberChatInput("/mcp reload docs")).toBe(true);
  });
});

describe("suggestChatCommands", () => {
  test("returns registry order for an empty query and matches case-insensitively", () => {
    expect(suggestChatCommands("").map(({ name }) => name)).toEqual([
      "help",
      "mcp",
      "config",
      "update",
      "model",
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

describe("completeChatInput", () => {
  const context = {
    mcp: {
      statuses: () => [
        { name: "github", transport: "http" as const, state: "connected" as const },
        { name: "docs", transport: "stdio" as const, state: "connecting" as const },
      ],
      reload: async () => {},
    },
  };

  test("guides nested MCP actions and dynamic server arguments", () => {
    const actionInput = "/mcp re";
    const action = completeChatInput(actionInput, actionInput.length, context);
    expect(action?.suggestions[0]).toMatchObject({ value: "reload ", label: "reload" });
    const serverInput = "/mcp reload g";
    const server = completeChatInput(serverInput, serverInput.length, context);
    expect(server?.suggestions[0]).toMatchObject({ value: "github ", label: "github" });
    expect(server?.hint).toContain("reload all");
  });

  test("completes model targets and guided handoff", () => {
    const targetInput = "/model sub";
    const target = completeChatInput(targetInput, targetInput.length, context);
    expect(target?.suggestions[0]).toMatchObject({ value: "subagents ", label: "subagents" });
    const selectedInput = "/model primary ";
    expect(completeChatInput(selectedInput, selectedInput.length, context)?.hint).toContain(
      "choose a provider",
    );
  });

  test("completes update channels", () => {
    const input = "/update ne";
    const completion = completeChatInput(input, input.length);
    expect(completion?.suggestions).toEqual([
      { value: "next", label: "next", summary: "Update to the next release" },
    ]);
  });

  test("enumerates schema config paths and enum values with contextual hints", () => {
    const keyInput = "/config set agent.tools.e";
    const key = completeChatInput(keyInput, keyInput.length, context);
    expect(key?.suggestions.map(({ label }) => label)).toContain("agent.tools.edit.mode");
    const valueInput = "/config set agent.tools.edit.mode ";
    const value = completeChatInput(valueInput, valueInput.length, context);
    expect(value?.suggestions.map(({ label }) => label)).toEqual(["batch", "exact", "hash"]);
    const secretInput = "/config set mcp.servers.github.headers.Authorization ";
    const secret = completeChatInput(secretInput, secretInput.length, context);
    expect(secret?.hint).toContain("masked");
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
        inspect: () => undefined,
        renewSoftTimeout: () => false,
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
    for (const name of [
      "/help",
      "/mcp",
      "/config",
      "/update",
      "/model",
      "/build",
      "/jobs",
      "/undo",
      "/redo",
      "/clear",
      "/quit",
    ]) {
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

  test("manages MCP configuration and reloads the affected server", async () => {
    const { context, events } = makeContext();
    const sets: Array<{ key: string; value?: string }> = [];
    const deletes: string[] = [];
    const reloads: Array<string | undefined> = [];
    context.config = {
      get: async ({ key }) => ({ ok: true, key, storage: "global_config", value: null }),
      set: async (input) => {
        sets.push(input);
        return { ok: true, key: input.key, storage: "global_config", changed: true };
      },
      delete: async ({ key }) => {
        deletes.push(key);
        return { ok: true, key, storage: "global_config", changed: true };
      },
    };
    context.mcp = {
      statuses: () => [{ name: "docs", transport: "http", state: "connected" }],
      reload: async (name) => {
        reloads.push(name);
      },
    };

    await runChatCommand(
      context,
      "mcp",
      'set docs {"transport":"http","url":"https://example.com/mcp"}',
    );
    expect(sets[0]?.key).toBe("mcp.servers.docs");
    expect(reloads).toEqual(["docs"]);
    await runChatCommand(context, "mcp", "remove docs");
    expect(deletes).toEqual(["mcp.servers.docs"]);
    expect(reloads).toEqual(["docs", "docs"]);

    await runChatCommand(context, "mcp", "");
    expect((events.at(-1) as { text: string }).text).toContain("docs [http] — connected");
  });

  test("guides MCP add and masked auth without placing values in command arguments", async () => {
    const { context } = makeContext();
    const answers = ["docs", "http", "https://example.com/mcp", "Bearer token"];
    const asks: Array<{ label: string; masked?: boolean }> = [];
    const sets: Array<{ key: string; value?: string }> = [];
    context.guided = {
      askInput: async (options) => {
        asks.push(options);
        return answers.shift() ?? null;
      },
    };
    context.config = {
      get: async ({ key }) => ({ ok: true, key, storage: "global_config" }),
      set: async (input) => {
        sets.push(input);
        return { ok: true, key: input.key, storage: "global_config", changed: true };
      },
      delete: async ({ key }) => ({ ok: true, key, storage: "global_config", changed: true }),
    };
    context.mcp = { statuses: () => [], reload: async () => {} };

    await runChatCommand(context, "mcp", "add");
    await runChatCommand(context, "mcp", "auth docs");
    expect(JSON.parse(sets[0]?.value ?? "{}")).toMatchObject({
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(sets[1]).toEqual({
      key: "mcp.servers.docs.headers.Authorization",
      value: '"Bearer token"',
    });
    expect(asks.at(-1)?.masked).toBe(true);
  });

  test("guides primary selection and lets subagents return to inheritance", async () => {
    const { context, events } = makeContext();
    const answers = ["primary", "azure", "gpt-5.6-luna", "inherit"];
    const configured: Array<{
      target: "primary" | "subagents";
      selection: { provider: string; model: string } | null;
    }> = [];
    context.guided = { askInput: async () => answers.shift() ?? null };
    context.models = {
      current: () => ({
        primary: { provider: "azure", model: "gpt-5.6-sol" },
        subagents: { provider: "azure", model: "gpt-5.6-terra" },
      }),
      providers: () => ["azure"],
      modelSuggestions: () => ["gpt-5.6-sol", "gpt-5.6-luna"],
      configure: async (target, selection) => {
        configured.push({ target, selection });
        return true;
      },
    };

    await runChatCommand(context, "model", "");
    await runChatCommand(context, "model", "subagents");

    expect(configured).toEqual([
      {
        target: "primary",
        selection: { provider: "azure", model: "gpt-5.6-luna" },
      },
      { target: "subagents", selection: null },
    ]);
    expect((events.at(-1) as { text: string }).text).toContain("inherit the primary");
  });

  test("update requests the selected channel and exits", async () => {
    const { context, quitCalls } = makeContext();
    const channels: string[] = [];
    context.requestUpdate = (channel) => {
      channels.push(channel);
    };
    await runChatCommand(context, "update", "next");
    await runChatCommand(context, "update", "");
    expect(channels).toEqual(["next", "auto"]);
    expect(quitCalls()).toBe(2);
  });

  test("update rejects unknown channels", async () => {
    const { context, events, quitCalls } = makeContext();
    context.requestUpdate = () => {};
    await runChatCommand(context, "update", "stable");
    expect((events.at(-1) as { text: string }).text).toContain("Usage: /update");
    expect(quitCalls()).toBe(0);
  });

  test("quit ends the session", async () => {
    const { context, quitCalls } = makeContext();
    await runChatCommand(context, "quit", "");
    expect(quitCalls()).toBe(1);
  });
});
