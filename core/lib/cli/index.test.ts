import { describe, expect, test } from "bun:test";

import type {
  ConversationEvent,
  ConversationOutcome,
  TaskRunEvent,
  TaskRunSessionIdentity,
} from "../app/conversation";
import { createConfigCliHandlers } from "../config-cli";
import type { PromptUi, TranscriptRenderer } from "../tui";
import {
  type AgentjCommandDependencies,
  EXIT_ABORTED,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  runAgentjCli,
} from "./index";

const SESSION: TaskRunSessionIdentity = {
  id: "session-123",
  branch: "feat/simple-tui",
  base: "origin/main",
  path: "/tmp/session-123",
};

const RESULT = {
  text: "Done.",
  steps: [],
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  },
};

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

function makeSuccessOutcome(commitSha: string | null = "abc123"): ConversationOutcome {
  return {
    kind: "success",
    session: SESSION,
    result: RESULT,
    commitSha,
  };
}

function makeGenerationErrorOutcome(): ConversationOutcome {
  return {
    kind: "generation-error",
    session: SESSION,
    error: new Error("generation failed"),
  };
}

function makeCommitErrorOutcome(): ConversationOutcome {
  return {
    kind: "commit-error",
    session: SESSION,
    result: RESULT,
    error: new Error("commit failed"),
  };
}

function makeAbortedOutcome(): ConversationOutcome {
  return {
    kind: "aborted",
    session: SESSION,
    error: new Error("aborted"),
  };
}

function createRendererSpy() {
  const prompts: string[] = [];
  const events: ConversationEvent[] = [];
  const outcomes: ConversationOutcome[] = [];

  const renderer: TranscriptRenderer = {
    renderPrompt() {
      prompts.push("renderPrompt");
    },
    renderEvent(event) {
      events.push(event);
    },
    renderOutcome(outcome) {
      outcomes.push(outcome);
    },
  };

  return { renderer, prompts, events, outcomes };
}

function createDependencies(options?: {
  promptTask?: string | null;
  outcome?: ConversationOutcome;
  onRunTask?: (
    task: string,
    options: Parameters<AgentjCommandDependencies["runTask"]>[1],
  ) => Promise<void> | void;
}) {
  const promptCalls = 0;
  const runTaskCalls: string[] = [];
  const runnerOptions: Parameters<AgentjCommandDependencies["runTask"]>[1][] = [];
  const rendererTasks: string[] = [];
  const renderer = createRendererSpy();
  const abortSignal = new AbortController().signal;
  let promptCallCount = 0;

  const deps: AgentjCommandDependencies = {
    version: "1.2.3",
    promptUi: {
      async askTask() {
        promptCallCount += 1;
        return options?.promptTask ?? null;
      },
    } satisfies PromptUi,
    createRenderer(task) {
      rendererTasks.push(task);
      return renderer.renderer;
    },
    async runTask(task, runOptions) {
      runTaskCalls.push(task);
      runnerOptions.push(runOptions);
      await options?.onRunTask?.(task, runOptions);
      return options?.outcome ?? makeSuccessOutcome();
    },
    createAbortSignal: () => abortSignal,
  };

  return {
    deps,
    getPromptCallCount: () => promptCallCount + promptCalls,
    runTaskCalls,
    runnerOptions,
    rendererTasks,
    renderer,
    abortSignal,
  };
}

describe("runAgentjCli", () => {
  test("positional task skips prompt and forwards the exact trimmed task", async () => {
    const {
      deps,
      getPromptCallCount,
      runTaskCalls,
      runnerOptions,
      rendererTasks,
      renderer,
      abortSignal,
    } = createDependencies();

    await expect(runAgentjCli(["  fix the flaky test  "], deps)).resolves.toBe(EXIT_SUCCESS);

    expect(getPromptCallCount()).toBe(0);
    expect(runTaskCalls).toEqual(["fix the flaky test"]);
    expect(rendererTasks).toEqual(["fix the flaky test"]);
    expect(renderer.prompts).toHaveLength(1);
    expect(renderer.outcomes).toHaveLength(1);
    expect(runnerOptions[0]?.signal).toBe(abortSignal);
  });

  test("missing task calls prompt once and forwards the prompt response", async () => {
    const { deps, getPromptCallCount, runTaskCalls, rendererTasks, renderer } = createDependencies({
      promptTask: "  explain the module boundary  ",
    });

    await expect(runAgentjCli([], deps)).resolves.toBe(EXIT_SUCCESS);

    expect(getPromptCallCount()).toBe(1);
    expect(runTaskCalls).toEqual(["explain the module boundary"]);
    expect(rendererTasks).toEqual(["explain the module boundary"]);
    expect(renderer.prompts).toHaveLength(1);
    expect(renderer.outcomes).toHaveLength(1);
  });

  test("prompt cancel and blank input exit 0 with no runner or renderer side effects", async () => {
    for (const promptTask of [null, "   "]) {
      const stdout = createMemoryWriter();
      const stderr = createMemoryWriter();
      const { deps, getPromptCallCount, runTaskCalls, rendererTasks, renderer } =
        createDependencies({ promptTask });

      await expect(runAgentjCli([], deps, { stdout, stderr })).resolves.toBe(EXIT_SUCCESS);

      expect(getPromptCallCount()).toBe(1);
      expect(runTaskCalls).toHaveLength(0);
      expect(rendererTasks).toHaveLength(0);
      expect(renderer.prompts).toHaveLength(0);
      expect(renderer.events).toHaveLength(0);
      expect(renderer.outcomes).toHaveLength(0);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe("");
    }
  });

  test("forwards lifecycle events and renders the outcome exactly once", async () => {
    const sessionCreated: TaskRunEvent = {
      type: "session-created",
      session: SESSION,
    };
    const toolCall: TaskRunEvent = {
      type: "tool-call",
      session: SESSION,
      call: {
        name: "read_file",
        input: { path: "README.md" },
      },
    };
    const toolResult: TaskRunEvent = {
      type: "tool-result",
      session: SESSION,
      result: {
        name: "read_file",
        output: { text: "ok" },
        isError: false,
      },
    };
    const resultEvent: TaskRunEvent = {
      type: "result",
      session: SESSION,
      result: RESULT,
    };
    const commitEvent: TaskRunEvent = {
      type: "commit",
      session: SESSION,
      result: RESULT,
      message: "Add commit",
      sha: "abc123",
    };
    const outcome = makeSuccessOutcome("abc123");

    const { deps, renderer } = createDependencies({
      outcome,
      async onRunTask(_task, options) {
        await options.onEvent?.(sessionCreated);
        await options.onEvent?.(toolCall);
        await options.onEvent?.(toolResult);
        await options.onEvent?.(resultEvent);
        await options.onEvent?.(commitEvent);
      },
    });

    await expect(runAgentjCli(["ship it"], deps)).resolves.toBe(EXIT_SUCCESS);

    expect(renderer.events).toEqual([
      sessionCreated,
      toolCall,
      toolResult,
      resultEvent,
      commitEvent,
    ]);
    expect(renderer.outcomes).toEqual([outcome]);
  });

  test("maps success and no-change to 0, generation and commit errors to 1, and aborted to 130", async () => {
    const cases = [
      { outcome: makeSuccessOutcome("abc123"), expectedExit: EXIT_SUCCESS },
      { outcome: makeSuccessOutcome(null), expectedExit: EXIT_SUCCESS },
      { outcome: makeGenerationErrorOutcome(), expectedExit: EXIT_FAILURE },
      { outcome: makeCommitErrorOutcome(), expectedExit: EXIT_FAILURE },
      {
        outcome: {
          kind: "build-blocked" as const,
          session: SESSION,
          reason: "validation failed",
          recoveryCommitSha: "def456",
        },
        expectedExit: EXIT_FAILURE,
      },
      { outcome: makeAbortedOutcome(), expectedExit: EXIT_ABORTED },
    ];

    for (const { outcome, expectedExit } of cases) {
      const { deps, runTaskCalls } = createDependencies({ outcome });
      await expect(runAgentjCli(["task"], deps)).resolves.toBe(expectedExit);
      expect(runTaskCalls).toEqual(["task"]);
    }
  });

  test("cmd-ts help writes stable stdout output and never calls the task runner", async () => {
    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const { deps, getPromptCallCount, runTaskCalls, rendererTasks } = createDependencies();

    await expect(runAgentjCli(["--help"], deps, { stdout, stderr })).resolves.toBe(EXIT_SUCCESS);

    expect(getPromptCallCount()).toBe(0);
    expect(runTaskCalls).toHaveLength(0);
    expect(rendererTasks).toHaveLength(0);
    expect(stdout.text()).toBe(
      "agentj 1.2.3\n" +
        "> Run one AgentJ task from the terminal.\n\n" +
        "ARGUMENTS:\n" +
        "  [str] - Task to run. If omitted, AgentJ asks once. [optional]\n\n" +
        "FLAGS:\n" +
        "  --help, -h    - show help [optional]\n" +
        "  --version, -v - print the version [optional]",
    );
    expect(stderr.text()).toBe("");
  });

  test("quoted task words are accepted as one positional arg, while extra unquoted args are rejected by cmd-ts", async () => {
    const accepted = createDependencies();

    await expect(runAgentjCli(["fix the flaky test"], accepted.deps)).resolves.toBe(EXIT_SUCCESS);

    expect(accepted.getPromptCallCount()).toBe(0);
    expect(accepted.runTaskCalls).toEqual(["fix the flaky test"]);

    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const rejected = createDependencies();

    await expect(
      runAgentjCli(["fix", "the", "flaky", "test"], rejected.deps, {
        stdout,
        stderr,
      }),
    ).resolves.toBe(EXIT_FAILURE);

    expect(rejected.getPromptCallCount()).toBe(0);
    expect(rejected.runTaskCalls).toHaveLength(0);
    expect(rejected.rendererTasks).toHaveLength(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "error: found 1 error\n\n" +
        "  fix the flaky test\n" +
        "      ^ Unknown arguments\n\n\n" +
        "hint: for more information, try 'agentj --help'",
    );
  });

  test("routes sandbox and resume forms through typed cmd-ts leaf commands", async () => {
    const created = createDependencies({ outcome: makeSuccessOutcome() });
    const sandboxCalls: Array<{ task: string; provider?: string }> = [];
    const resumeCalls: string[] = [];
    created.deps.runSandboxTask = async (task, options) => {
      sandboxCalls.push({ task, ...(options.provider ? { provider: options.provider } : {}) });
      return makeSuccessOutcome();
    };
    created.deps.resumeSession = async (id) => {
      resumeCalls.push(id);
      return makeSuccessOutcome();
    };

    await expect(runAgentjCli(["sandbox", "task"], created.deps)).resolves.toBe(EXIT_SUCCESS);
    await expect(
      runAgentjCli(["sandbox", "--provider", "microsandbox", "other"], created.deps),
    ).resolves.toBe(EXIT_SUCCESS);
    await expect(runAgentjCli(["--resume", "abc123"], created.deps)).resolves.toBe(EXIT_SUCCESS);

    expect(sandboxCalls).toEqual([{ task: "task" }, { task: "other", provider: "microsandbox" }]);
    expect(resumeCalls).toEqual(["abc123"]);
    expect(created.runTaskCalls).toEqual([]);
  });

  test("rejects missing sandbox provider and resume values before running", async () => {
    const created = createDependencies();
    created.deps.runSandboxTask = async () => makeSuccessOutcome();
    created.deps.resumeSession = async () => makeSuccessOutcome();
    const stderr = createMemoryWriter();

    await expect(
      runAgentjCli(["sandbox", "--provider"], created.deps, { stderr }),
    ).resolves.toBeGreaterThan(0);
    await expect(runAgentjCli(["--resume"], created.deps, { stderr })).resolves.toBeGreaterThan(0);
    expect(created.runTaskCalls).toEqual([]);
  });

  test("config set parses normal and secret inputs before calling injected handlers", async () => {
    const normal = createDependencies();
    const normalCalls: unknown[] = [];
    normal.deps.configHandlers = {
      async get() {
        throw new Error("get should not run");
      },
      async set(input) {
        normalCalls.push(input);
        return { ok: true, key: "llm.model", storage: "global_config", changed: true };
      },
      async delete() {
        throw new Error("delete should not run");
      },
      async add() {
        throw new Error("add should not run");
      },
      async remove() {
        throw new Error("remove should not run");
      },
    };

    await expect(
      runAgentjCli(["config", "set", "llm.model", "azure/gpt-5.6-sol"], normal.deps),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(normalCalls).toEqual([{ key: "llm.model", secret: false, value: "azure/gpt-5.6-sol" }]);

    const secret = createDependencies();
    const secretCalls: unknown[] = [];
    secret.deps.configHandlers = {
      async get() {
        throw new Error("get should not run");
      },
      async set(input) {
        secretCalls.push(input);
        return { ok: true, key: "providers.azure.api_key", storage: "keychain", changed: true };
      },
      async delete() {
        throw new Error("delete should not run");
      },
      async add() {
        throw new Error("add should not run");
      },
      async remove() {
        throw new Error("remove should not run");
      },
    };

    await expect(
      runAgentjCli(["config", "set", "--secret", "providers.azure.api_key"], secret.deps),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(secretCalls).toEqual([
      { key: "providers.azure.api_key", secret: true, value: undefined },
    ]);
  });

  test("config delete routes the public key and secret flag to injected handlers", async () => {
    const { deps } = createDependencies();
    const calls: unknown[] = [];
    deps.configHandlers = {
      async get() {
        throw new Error("get should not run");
      },
      async set() {
        throw new Error("set should not run");
      },
      async delete(input) {
        calls.push(input);
        return { ok: true, key: "llm.model", storage: "global_config", changed: true };
      },
      async add() {
        throw new Error("add should not run");
      },
      async remove() {
        throw new Error("remove should not run");
      },
    };

    await expect(runAgentjCli(["config", "delete", "llm.model"], deps)).resolves.toBe(EXIT_SUCCESS);
    await expect(
      runAgentjCli(["config", "delete", "--secret", "providers.azure.api_key"], deps),
    ).resolves.toBe(EXIT_SUCCESS);

    expect(calls).toEqual([
      { key: "llm.model", secret: false },
      { key: "providers.azure.api_key", secret: true },
    ]);
  });

  test("config get, add, and remove route generic key paths to their handlers", async () => {
    const { deps } = createDependencies();
    const calls: Array<{ operation: string; input: unknown }> = [];
    deps.configHandlers = {
      async get(input) {
        calls.push({ operation: "get", input });
        return { ok: true, key: input.key, storage: "global_config", value: [] };
      },
      async set() {
        throw new Error("set should not run");
      },
      async add(input) {
        calls.push({ operation: "add", input });
        return { ok: true, key: input.key, storage: "global_config", changed: true };
      },
      async remove(input) {
        calls.push({ operation: "remove", input });
        return { ok: true, key: input.key, storage: "global_config", changed: true };
      },
      async delete() {
        throw new Error("delete should not run");
      },
    };

    await expect(runAgentjCli(["config", "get", "sandbox.bootstrap"], deps)).resolves.toBe(
      EXIT_SUCCESS,
    );
    await expect(
      runAgentjCli(["config", "add", "sandbox.bootstrap", "apt-get update"], deps),
    ).resolves.toBe(EXIT_SUCCESS);
    await expect(
      runAgentjCli(["config", "remove", "sandbox.bootstrap", "apt-get update"], deps),
    ).resolves.toBe(EXIT_SUCCESS);

    expect(calls).toEqual([
      { operation: "get", input: { key: "sandbox.bootstrap" } },
      { operation: "add", input: { key: "sandbox.bootstrap", value: "apt-get update" } },
      { operation: "remove", input: { key: "sandbox.bootstrap", value: "apt-get update" } },
    ]);
  });

  test("config set rejects a secret value without prompting, storing, or writing success output", async () => {
    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    let promptCalls = 0;
    let storeCalls = 0;
    const handlers = createConfigCliHandlers({
      prompt: {
        async askSecret() {
          promptCalls += 1;
          return "secret";
        },
      },
      secretStore: {
        async set() {
          storeCalls += 1;
        },
        async get() {
          return undefined;
        },
        async delete() {
          return false;
        },
      },
      writers: { stdout, stderr },
      mutateConfig: async () => {
        throw new Error("normal config mutation should not run");
      },
    });
    const { deps } = createDependencies();
    deps.configHandlers = handlers;

    await expect(
      runAgentjCli(
        ["config", "set", "--secret", "providers.azure.api_key", "must-not-store"],
        deps,
        { stdout, stderr },
      ),
    ).resolves.toBe(EXIT_FAILURE);

    expect(promptCalls).toBe(0);
    expect(storeCalls).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("--secret is only valid for secret configuration keys.\n");
  });

  test("eval routes preserve injected exit codes, while help and unknown routes do not invoke handlers", async () => {
    const { deps } = createDependencies();
    const calls: string[] = [];
    deps.evalHandlers = {
      async run() {
        calls.push("run");
        return 7;
      },
      async report() {
        calls.push("report");
        return 8;
      },
      async selfcheck() {
        calls.push("selfcheck");
        return 9;
      },
    };

    await expect(runAgentjCli(["eval"], deps)).resolves.toBe(7);
    await expect(runAgentjCli(["eval", "report"], deps)).resolves.toBe(8);
    await expect(runAgentjCli(["eval", "selfcheck"], deps)).resolves.toBe(9);
    expect(calls).toEqual(["run", "report", "selfcheck"]);

    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    await expect(runAgentjCli(["eval", "--help"], deps, { stdout, stderr })).resolves.toBe(
      EXIT_SUCCESS,
    );
    await expect(runAgentjCli(["eval", "unknown"], deps, { stdout, stderr })).resolves.toBe(2);
    expect(calls).toEqual(["run", "report", "selfcheck"]);
    expect(stdout.text()).toContain("Run AgentJ evaluation commands.");
    expect(stderr.text()).toBe("error: unknown eval command. Try 'agentj eval --help'.\n");
  });

  test("bare config remains task input while incomplete config subcommands use the parser error path", async () => {
    const bare = createDependencies();
    await expect(runAgentjCli(["config"], bare.deps)).resolves.toBe(EXIT_SUCCESS);
    expect(bare.runTaskCalls).toEqual(["config"]);

    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const incomplete = createDependencies();
    incomplete.deps.configHandlers = {
      async get() {
        throw new Error("get should not run");
      },
      async set() {
        throw new Error("set should not run");
      },
      async delete() {
        throw new Error("delete should not run");
      },
      async add() {
        throw new Error("add should not run");
      },
      async remove() {
        throw new Error("remove should not run");
      },
    };

    await expect(
      runAgentjCli(["config", "set"], incomplete.deps, { stdout, stderr }),
    ).resolves.toBe(EXIT_FAILURE);
    expect(incomplete.runTaskCalls).toHaveLength(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("No value provided for key");
  });
});
