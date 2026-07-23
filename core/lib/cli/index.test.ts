import { describe, expect, test } from "bun:test";

import type { ConfigCliHandlers } from "../config-cli";
import {
  describeCli,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  type GloriousCommandDependencies,
  type RunOnceOptions,
  runGloriousCli,
} from "./index";

function createMemoryWriter(): { write: (text: string) => true; text: () => string } {
  const chunks: string[] = [];

  return {
    write(text) {
      chunks.push(text);
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

function makeDeps(over: Partial<GloriousCommandDependencies> = {}) {
  const chatCalls: Array<{ resume?: string; continueLatest?: boolean } | undefined> = [];
  const onceCalls: Array<{ task: string; options: RunOnceOptions }> = [];
  const deps: GloriousCommandDependencies = {
    version: "1.2.3",
    async runChat(options) {
      chatCalls.push(options);
      return EXIT_SUCCESS;
    },
    async runOnce(task, options) {
      onceCalls.push({ task, options });
      return EXIT_SUCCESS;
    },
    ...over,
  };
  return { deps, chatCalls, onceCalls };
}

describe("runGloriousCli", () => {
  test("bare invocation opens the chat session", async () => {
    const { deps, chatCalls } = makeDeps();
    await expect(runGloriousCli([], deps)).resolves.toBe(EXIT_SUCCESS);
    expect(chatCalls).toEqual([{ continueLatest: false }]);
  });

  test("--continue and --resume route into chat with resume options", async () => {
    const { deps, chatCalls } = makeDeps();
    await expect(runGloriousCli(["--continue"], deps)).resolves.toBe(EXIT_SUCCESS);
    await expect(runGloriousCli(["--resume", "abc123"], deps)).resolves.toBe(EXIT_SUCCESS);
    expect(chatCalls[0]).toEqual({ continueLatest: true });
    expect(chatCalls[1]).toEqual({ resume: "abc123", continueLatest: false });
  });

  test("run executes one trimmed task with flags and a signal", async () => {
    const abort = new AbortController();
    const { deps, onceCalls } = makeDeps({ createAbortSignal: () => abort.signal });
    await expect(
      runGloriousCli(["run", "--plan", "--allow-all", "  fix the flaky test  "], deps),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(onceCalls).toEqual([
      {
        task: "fix the flaky test",
        options: { plan: true, allowAll: true, signal: abort.signal },
      },
    ]);
  });

  test("run without a task is a usage error, not a chat session", async () => {
    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const { deps, chatCalls, onceCalls } = makeDeps();
    const code = await runGloriousCli(["run"], deps, { stdout, stderr });
    expect(code).not.toBe(EXIT_SUCCESS);
    expect(chatCalls).toHaveLength(0);
    expect(onceCalls).toHaveLength(0);
  });

  test("runOnce exit codes propagate", async () => {
    const { deps } = makeDeps({ runOnce: async () => 130 });
    await expect(runGloriousCli(["run", "task"], deps)).resolves.toBe(130);
  });

  test("update routes the selected channel and defaults to automatic channel selection", async () => {
    const calls: Array<{ channel: "auto" | "next" | "latest" }> = [];
    const { deps } = makeDeps({
      update: async (options) => {
        calls.push(options);
        return EXIT_SUCCESS;
      },
    });

    await expect(runGloriousCli(["update"], deps)).resolves.toBe(EXIT_SUCCESS);
    await expect(runGloriousCli(["update", "--channel", "next"], deps)).resolves.toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ channel: "auto" }, { channel: "next" }]);
  });

  test("update rejects an invalid channel without invoking the handler", async () => {
    const stderr = createMemoryWriter();
    const update = async () => EXIT_SUCCESS;
    const { deps } = makeDeps({ update });

    await expect(
      runGloriousCli(["update", "--channel", "stable"], deps, { stderr }),
    ).resolves.not.toBe(EXIT_SUCCESS);
    expect(stderr.text()).toContain("stable");
  });

  test("config routes dispatch to handlers and report failures", async () => {
    const calls: string[] = [];
    const handlers = {
      set: async ({ key }: { key: string }) => {
        calls.push(`set:${key}`);
        return { ok: true };
      },
      get: async ({ key }: { key: string }) => {
        calls.push(`get:${key}`);
        return { ok: false };
      },
      add: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    } as unknown as ConfigCliHandlers;
    const { deps } = makeDeps({ configHandlers: handlers });

    await expect(runGloriousCli(["config", "set", "agent.llm.model", "m"], deps)).resolves.toBe(
      EXIT_SUCCESS,
    );
    await expect(runGloriousCli(["config", "get", "agent.llm.model"], deps)).resolves.toBe(
      EXIT_FAILURE,
    );
    expect(calls).toEqual(["set:agent.llm.model", "get:agent.llm.model"]);
  });

  test("config without handlers fails with a message", async () => {
    const stderr = createMemoryWriter();
    const { deps } = makeDeps();
    await expect(
      runGloriousCli(["config", "get", "agent.llm.model"], deps, { stderr }),
    ).resolves.toBe(EXIT_FAILURE);
    expect(stderr.text()).toContain("config commands are not available");
  });

  test("eval routes: default run, report/selfcheck, help, unknown", async () => {
    const invoked: string[] = [];
    const handlers = {
      run: async () => {
        invoked.push("run");
        return 0;
      },
      report: async () => {
        invoked.push("report");
        return 0;
      },
      selfcheck: async () => {
        invoked.push("selfcheck");
        return 0;
      },
    };
    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const { deps } = makeDeps({ evalHandlers: handlers });

    await expect(runGloriousCli(["eval"], deps)).resolves.toBe(0);
    await expect(runGloriousCli(["eval", "report"], deps)).resolves.toBe(0);
    await expect(runGloriousCli(["eval", "selfcheck"], deps)).resolves.toBe(0);
    expect(invoked).toEqual(["run", "report", "selfcheck"]);

    await expect(runGloriousCli(["eval", "--help"], deps, { stdout })).resolves.toBe(EXIT_SUCCESS);
    expect(stdout.text()).toContain("report or selfcheck");

    await expect(runGloriousCli(["eval", "bogus"], deps, { stderr })).resolves.toBe(2);
    expect(stderr.text()).toContain("unknown eval command");
  });

  test("--help renders the chat surface without invoking anything", async () => {
    const stdout = createMemoryWriter();
    const { deps, chatCalls, onceCalls } = makeDeps();
    await expect(runGloriousCli(["--help"], deps, { stdout })).resolves.toBe(EXIT_SUCCESS);
    expect(stdout.text()).toContain("chat");
    expect(chatCalls).toHaveLength(0);
    expect(onceCalls).toHaveLength(0);
  });

  test("describeCli extracts every command's args and flags without running handlers", () => {
    const cli = describeCli();
    const run = cli.find((c) => c.name === "glorious run");
    expect(run?.args.map((a) => a.usage)).toEqual(["<task>"]);
    expect(run?.flags.map((f) => f.usage)).toEqual(["--plan", "--allow-all"]);
    // A value-taking option is captured too, not only boolean flags.
    const chat = cli.find((c) => c.name === "glorious");
    expect(chat?.flags.some((f) => f.usage === "--resume <str>")).toBe(true);
    // The auto-added help flag is excluded from the reference.
    expect(cli.every((c) => c.flags.every((f) => !f.usage.startsWith("--help")))).toBe(true);
  });
});
