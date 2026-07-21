import { describe, expect, test } from "bun:test";
import {
  type ChatCommandContext,
  completeChatInput,
  parseInput,
  runChatCommand,
  shouldRememberChatInput,
  suggestChatCommands,
  suggestChatInputRoots,
} from "./commands";
import type { ChatEvent } from "./events";
import type { GuidedInputOptions } from "./guided-input";
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
      "cost",
      "activity",
      "todos",
      "build",
      "jobs",
      "undo",
      "redo",
      "clear",
      "compact",
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
    jobs: {
      list: () => [{ id: "j1", mode: "plan", prompt: "research", status: "running", startedAt: 0 }],
    } as JobRunner,
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

  test("returns no root candidates once a slash query cannot match", () => {
    expect(suggestChatInputRoots("bld")).toContainEqual(
      expect.objectContaining({ label: "/build" }),
    );
    expect(suggestChatInputRoots("no-such-command")).toEqual([]);
  });

  test("recognizes namespaced MCP prompt invocations without shadowing built-ins", () => {
    const promptContext = {
      ...context,
      mcp: {
        ...context.mcp,
        prompts: () => [{ server: "docs", name: "summarize" }],
      },
    };
    expect(completeChatInput("/mcp:docs:summarize ", 20, promptContext)?.hint).toContain(
      "provide MCP prompt",
    );
    expect(completeChatInput("/mcp:", 5, promptContext)?.suggestions).toContainEqual(
      expect.objectContaining({ label: "/mcp:docs:summarize" }),
    );
    expect(
      completeChatInput("/mcp ", 5, promptContext)?.suggestions.map(({ label }) => label),
    ).toContain("add");
    expect(suggestChatInputRoots("mds", promptContext)).toContainEqual(
      expect.objectContaining({ label: "/mcp:docs:summarize" }),
    );
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

  test("completes job inspection and abort actions", () => {
    const inspectInput = "/jobs ";
    expect(completeChatInput(inspectInput, inspectInput.length, context)?.suggestions).toEqual([
      { value: "abort ", label: "abort", summary: "Abort a running job" },
      { value: "j1 ", label: "j1", summary: "Background job" },
    ]);
    const abortInput = "/jobs abort ";
    expect(completeChatInput(abortInput, abortInput.length, context)?.suggestions).toEqual([
      { value: "j1 ", label: "j1", summary: "Background job" },
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
        inspect: (id: string) =>
          id === "j1"
            ? {
                id: "j1",
                mode: "plan",
                prompt: "research",
                status: "done",
                startedAt: 0,
                endedAt: 74_000,
                resultText: "research complete",
                recentActivity: ["readFile AGENTS.md"],
              }
            : undefined,
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
      "/activity",
      "/todos",
      "/build",
      "/jobs",
      "/undo",
      "/redo",
      "/clear",
      "/compact",
      "/quit",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("complete a shown command");
  });

  test("activity reports completed tool work without adding transcript rows by default", async () => {
    const { context, events } = makeContext();
    context.activity = {
      list: () => [{ tool: "run_one_subagent", detail: "inspect commands", elapsedMs: 1_200 }],
    };

    await runChatCommand(context, "activity", "");

    expect((events.at(-1) as { text: string }).text).toBe(
      "✓ run_one_subagent inspect commands 1.2s",
    );
  });

  test("todos prints the current full session list", async () => {
    const { context, events } = makeContext();
    context.todos = {
      list: () => [
        { id: "one", text: "Inspect", status: "completed" },
        { id: "two", text: "Build", status: "in_progress" },
      ],
    };

    await runChatCommand(context, "todos", "");

    expect(events).toEqual([
      { type: "command", name: "todos" },
      { type: "notice", text: "Todos 1/2 done · 1 active\n✓ Inspect\n→ Build" },
    ]);
  });

  test("clear resets the session context and reports when a turn is active", async () => {
    const { context, events } = makeContext();
    let clearCalls = 0;
    context.session = {
      clearContext: async () => {
        clearCalls += 1;
        return clearCalls === 1;
      },
    } as ChatCommandContext["session"];

    await runChatCommand(context, "clear", "");
    expect(clearCalls).toBe(1);
    expect(events).toEqual([{ type: "command", name: "clear" }]);

    await runChatCommand(context, "clear", "");
    expect(events.at(-1)).toEqual({
      type: "notice",
      text: "Cannot clear context while a turn is running.",
    });
  });

  test("compact compacts the session context and reports when a turn is active", async () => {
    const { context, events } = makeContext();
    let calls = 0;
    context.session = {
      compactContext: async () => {
        calls += 1;
        return calls === 1;
      },
    } as ChatCommandContext["session"];

    await runChatCommand(context, "compact", "");
    expect(calls).toBe(1);
    expect(events).toEqual([{ type: "command", name: "compact" }]);
    await runChatCommand(context, "compact", "");
    expect(events.at(-1)).toEqual({
      type: "notice",
      text: "Cannot compact context while a turn is running.",
    });
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
        calls.push(`send:${options?.transcriptText}:${options?.restoreText}:${text}`);
      },
    } as ChatCommandContext["session"];

    await runChatCommand(context, "build", "please prioritize the API tests");

    expect(calls).toEqual([
      "mode:build",
      "send:Command: build:/build please prioritize the API tests:Implement the work agreed on in this conversation, incorporating the plan, discussion, and user feedback, including this additional feedback: please prioritize the API tests. Complete and validate it end to end.",
    ]);
  });

  test("jobs lists, inspects, and aborts; undo/redo report labels; unknown suggests help", async () => {
    const { context, events, aborted } = makeContext();
    await runChatCommand(context, "jobs", "");
    expect(events[0]).toEqual({ type: "command", name: "jobs" });
    expect((events.at(-1) as { text: string }).text).toContain("j1 [running]");

    await runChatCommand(context, "jobs", "j1");
    const detail = (events.at(-1) as { text: string }).text;
    expect(detail).toContain("[j1] done (plan) — 1m14s");
    expect(detail).toContain("recent tool calls:\n  readFile AGENTS.md");
    expect(detail).toContain("result:\nresearch complete");

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

  test("edits string-array config values through guided list actions", async () => {
    const { context } = makeContext();
    const answers = ["add", "second", "edit", "updated", "save"];
    const asks: GuidedInputOptions[] = [];
    const sets: Array<{ key: string; value?: string }> = [];
    context.guided = {
      askInput: async (options) => {
        asks.push(options);
        return answers.shift() ?? null;
      },
    };
    context.config = {
      get: async ({ key }) => ({ ok: true, key, storage: "global_config", value: ["first"] }),
      set: async (input) => {
        sets.push(input);
        return { ok: true, key: input.key, storage: "global_config", changed: true };
      },
      delete: async ({ key }) => ({ ok: true, key, storage: "global_config", changed: true }),
    };

    await runChatCommand(context, "config", "set agent.llm.tiers");

    expect(sets).toEqual([{ key: "agent.llm.tiers", value: '["first","updated"]' }]);
    expect(asks[0]?.label).toContain("> first");
    expect(asks[0]?.choices).toContain("add");
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

  test("invokes namespaced MCP prompts with validated guided arguments as an external turn", async () => {
    const { context, events } = makeContext();
    const asks: Array<{ label: string; validate?: (value: string) => string | null | undefined }> =
      [];
    const sent: Array<{ text: string; transcript?: string }> = [];
    context.guided = {
      askInput: async (options) => {
        asks.push(options);
        return "release notes";
      },
    };
    context.session = {
      send: async (text: string, options?: { transcriptText?: string; restoreText?: string }) => {
        sent.push({ text, transcript: options?.transcriptText });
      },
    } as unknown as ChatCommandContext["session"];
    context.mcp = {
      statuses: () => [],
      reload: async () => {},
      prompts: () => [
        { server: "docs", name: "summarize", arguments: [{ name: "topic", required: true }] },
      ],
      getPrompt: async (_server, _prompt, args) => ({
        messages: [
          {
            role: "user",
            content: { type: "resource", resource: { uri: "docs://release", text: args.topic } },
          },
        ],
      }),
    };
    await runChatCommand(context, "mcp", "");
    expect((events.at(-1) as { text: string }).text).toContain("/mcp:docs:summarize");
    events.length = 0;
    await runChatCommand(context, "mcp:docs:summarize", "");
    expect(events).toEqual([]);
    expect(asks[0]?.validate?.("")).toContain("required");
    expect(sent[0]?.transcript).toBe("MCP prompt: docs/summarize");
    expect(sent[0]?.text).toContain("External instructions from MCP server docs");
    expect(sent[0]?.text).toContain("release notes");

    await runChatCommand(context, "mcp:docs:summarize", "leak");
    expect((events.at(-1) as { text: string }).text).toContain("collected interactively");
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

describe("skill commands", () => {
  const shipSkill = {
    name: "ship",
    summary: "Ship finished work.",
    mode: "build" as const,
    prompt: (args: string) => `SHIP BODY${args ? ` :: ${args}` : ""}`,
  };

  function makeSkillContext() {
    const events: ChatEvent[] = [];
    const calls: string[] = [];
    const context = {
      session: {
        setMode: (mode?: "plan" | "build") => {
          calls.push(`mode:${mode}`);
          return mode ?? "plan";
        },
        send: async (text: string, options?: { transcriptText?: string; restoreText?: string }) => {
          calls.push(`send:${options?.transcriptText}:${options?.restoreText}:${text}`);
        },
      } as unknown as ChatCommandContext["session"],
      jobs: {} as JobRunner,
      emit: (event: ChatEvent) => {
        events.push(event);
      },
      quit: () => {},
      skills: [shipSkill],
    } satisfies ChatCommandContext;
    return { context, events, calls };
  }

  test("invoking a skill switches mode and sends its prompt as a turn", async () => {
    const { context, events, calls } = makeSkillContext();
    await runChatCommand(context, "ship", "fast please");
    expect(events).toEqual([]); // startsTurn semantics: no command event
    expect(calls).toEqual([
      "mode:build",
      "send:Command: ship:/ship fast please:SHIP BODY :: fast please",
    ]);
  });

  test("built-in commands shadow same-named skills and unknown names still notice", async () => {
    const { context, events, calls } = makeSkillContext();
    context.skills = [{ ...shipSkill, name: "help" }, shipSkill];
    await runChatCommand(context, "help", "");
    expect(calls).toEqual([]);
    expect(events[0]).toEqual({ type: "command", name: "help" });
    expect((events[1] as { text: string }).text).toContain("/ship — Ship finished work. (skill)");
    await runChatCommand(context, "nope", "");
    expect((events.at(-1) as { text: string }).text).toContain("Unknown command /nope");
  });

  test("suggestions and completion include skills without shadowing built-ins", () => {
    const skills = [shipSkill, { ...shipSkill, name: "quit", summary: "shadowed" }];
    const names = suggestChatCommands("", skills).map(({ name }) => name);
    expect(names).toContain("ship");
    expect(names.filter((name) => name === "quit")).toHaveLength(1);
    expect(suggestChatCommands("shi", skills)[0]).toEqual({
      name: "ship",
      summary: "Ship finished work. (skill)",
    });

    const completion = completeChatInput("/ship ", 6, { skills });
    expect(completion?.hint).toBe("Press Enter to run the ship skill (build mode).");
    const top = completeChatInput("/sh", 3, { skills });
    expect(top?.suggestions.map(({ label }) => label)).toContain("/ship");
  });
});
