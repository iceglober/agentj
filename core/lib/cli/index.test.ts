import { describe, expect, test } from "bun:test";

import type {
  TaskRunEvent,
  TaskRunOutcome,
  TaskRunSessionIdentity,
} from "../app/run";
import type { PromptUi, TranscriptRenderer } from "../tui";
import {
  EXIT_ABORTED,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  runAgentjCli,
  type AgentjCommandDependencies,
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

function makeSuccessOutcome(commitSha: string | null = "abc123"): TaskRunOutcome {
  return {
    kind: "success",
    session: SESSION,
    result: RESULT,
    commitSha,
  };
}

function makeGenerationErrorOutcome(): TaskRunOutcome {
  return {
    kind: "generation-error",
    session: SESSION,
    error: new Error("generation failed"),
  };
}

function makeCommitErrorOutcome(): TaskRunOutcome {
  return {
    kind: "commit-error",
    session: SESSION,
    result: RESULT,
    error: new Error("commit failed"),
  };
}

function makeAbortedOutcome(): TaskRunOutcome {
  return {
    kind: "aborted",
    session: SESSION,
    error: new Error("aborted"),
  };
}

function createRendererSpy() {
  const prompts: string[] = [];
  const events: TaskRunEvent[] = [];
  const outcomes: TaskRunOutcome[] = [];

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
  outcome?: TaskRunOutcome;
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
    const { deps, getPromptCallCount, runTaskCalls, runnerOptions, rendererTasks, renderer, abortSignal } =
      createDependencies();

    await expect(runAgentjCli(["  fix the flaky test  "], deps)).resolves.toBe(
      EXIT_SUCCESS,
    );

    expect(getPromptCallCount()).toBe(0);
    expect(runTaskCalls).toEqual(["fix the flaky test"]);
    expect(rendererTasks).toEqual(["fix the flaky test"]);
    expect(renderer.prompts).toHaveLength(1);
    expect(renderer.outcomes).toHaveLength(1);
    expect(runnerOptions[0]?.signal).toBe(abortSignal);
  });

  test("missing task calls prompt once and forwards the prompt response", async () => {
    const { deps, getPromptCallCount, runTaskCalls, rendererTasks, renderer } =
      createDependencies({ promptTask: "  explain the module boundary  " });

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

      await expect(
        runAgentjCli([], deps, { stdout, stderr }),
      ).resolves.toBe(EXIT_SUCCESS);

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

    await expect(
      runAgentjCli(["--help"], deps, { stdout, stderr }),
    ).resolves.toBe(EXIT_SUCCESS);

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

    await expect(runAgentjCli(["fix the flaky test"], accepted.deps)).resolves.toBe(
      EXIT_SUCCESS,
    );

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
});
