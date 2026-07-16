import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import type { ConversationEvent } from "../app/conversation";
import type { TaskRunEvent, TaskRunOutcome, TaskRunSessionIdentity } from "../app/run";
import {
  createPromptUi,
  createTranscriptRenderer,
  safeRenderJson,
  type TerminalWriter,
  type TextPromptEditor,
  type TextPromptRequest,
} from "./index";

const SESSION: TaskRunSessionIdentity = {
  id: "session-123",
  branch: "feat/simple-tui",
  base: "main",
  path: "/tmp/session-123",
};

const createMemoryWriter = (): {
  writer: TerminalWriter;
  text: () => string;
} => {
  const chunks: string[] = [];

  return {
    writer: {
      write(text) {
        chunks.push(text);
      },
    },
    text: () => chunks.join(""),
  };
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

describe("createPromptUi", () => {
  const fakeEditor = (
    values: Array<string | null>,
    requests: TextPromptRequest[] = [],
  ): TextPromptEditor => ({
    async read(request) {
      requests.push(request);
      return values.shift() ?? null;
    },
  });

  test("preserves internal newlines, trims the task, and passes configured IO through", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const requests: TextPromptRequest[] = [];
    const ui = createPromptUi({
      editor: fakeEditor(["  fix the flaky test\nthen add coverage  "], requests),
      stdin,
      stdout,
    });

    await expect(ui.askTask()).resolves.toBe("fix the flaky test\nthen add coverage");
    expect(requests[0]).toMatchObject({
      message:
        "What should AgentJ plan and build?\nExamples: fix a failing test; explain a module boundary; add a targeted regression test.",
      hint: "Describe one coding task.",
      stdin,
      stdout,
    });
  });

  test("uses one blank-input retry workflow for tasks and follow-up feedback", async () => {
    const taskRequests: TextPromptRequest[] = [];
    const taskUi = createPromptUi({
      editor: fakeEditor(["   ", "  first line\nsecond line  "], taskRequests),
    });
    await expect(taskUi.askTask()).resolves.toBe("first line\nsecond line");
    expect(taskRequests[0]?.validationMessage).toBeUndefined();
    expect(taskRequests[1]?.validationMessage).toBe("Enter a task, or press Ctrl+C to cancel.");

    const feedbackRequests: TextPromptRequest[] = [];
    const feedbackUi = createPromptUi({
      editor: fakeEditor(["", "  revise this\nand that  "], feedbackRequests),
    });
    await expect(feedbackUi.askFollowUp?.()).resolves.toBe("revise this\nand that");
    expect(feedbackRequests[1]?.validationMessage).toBe(
      "Enter feedback, approval, or press Ctrl+C to stop.",
    );
  });

  test("returns null without invoking the editor for noninteractive or closed input", async () => {
    let invocations = 0;
    const editor: TextPromptEditor = {
      async read() {
        invocations += 1;
        return "not reached";
      },
    };
    const noninteractive = createPromptUi({ editor, isInteractive: false });
    await expect(noninteractive.askTask()).resolves.toBeNull();

    const destroyed = new PassThrough();
    destroyed.destroy();
    const closed = createPromptUi({ editor, stdin: destroyed });
    await expect(closed.askTask()).resolves.toBeNull();

    const ended = new PassThrough();
    ended.end();
    for await (const _ of ended) {
      // Drain the stream so readableEnded is observable.
    }
    const eof = createPromptUi({ editor, stdin: ended });
    await expect(eof.askTask()).resolves.toBeNull();
    expect(invocations).toBe(0);
  });

  test("returns null on editor cancellation and honors per-call stream overrides", async () => {
    const configuredInput = new PassThrough();
    const overrideInput = new PassThrough();
    const overrideOutput = new PassThrough();
    const requests: TextPromptRequest[] = [];
    const ui = createPromptUi({
      editor: fakeEditor([null], requests),
      stdin: configuredInput,
    });

    await expect(ui.askTask({ stdin: overrideInput, stdout: overrideOutput })).resolves.toBeNull();
    expect(requests[0]?.stdin).toBe(overrideInput);
    expect(requests[0]?.stdout).toBe(overrideOutput);
  });
});

describe("safeRenderJson", () => {
  test("never throws for circular or unserializable payloads", () => {
    const circular: Record<string, unknown> = { name: "payload" };
    circular.self = circular;
    Object.defineProperty(circular, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });

    expect(() => safeRenderJson(circular, 200)).not.toThrow();
    expect(safeRenderJson(circular, 200)).toContain("[Circular]");
    expect(safeRenderJson(circular, 200)).toContain("[Thrown Error: nope]");
  });
});

describe("createTranscriptRenderer", () => {
  const toolCall = (input: unknown): TaskRunEvent => ({
    type: "tool-call",
    session: SESSION,
    call: {
      name: "read_file",
      input,
    },
  });

  const toolResult = (output: unknown, isError = false): TaskRunEvent => ({
    type: "tool-result",
    session: SESSION,
    result: {
      name: "read_file",
      output,
      isError,
    },
  });

  const dagStarted = (): ConversationEvent => ({
    type: "subagent-progress",
    session: SESSION,
    progress: {
      type: "dag-started",
      concurrency: 2,
      startedAt: 1000,
      lanes: [
        {
          id: 1,
          title: "Repository research",
          waitsOn: [],
          tasks: [{ id: "1.1", title: "Map modules" }],
        },
        {
          id: 2,
          title: "Command design",
          waitsOn: [1],
          tasks: [{ id: "2.1", title: "Design command" }],
        },
      ],
    },
  });

  test("routes prompt and session header to stderr with exact copy", () => {
    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "explain the module boundary",
      color: false,
      writers: {
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    });

    renderer.renderPrompt();
    renderer.renderEvent({ type: "session-created", session: SESSION });

    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "Prompt: explain the module boundary\n" +
        "Session: session-123 | feat/simple-tui from main\n",
    );
  });

  test("renders sandbox image, bootstrap state, and a safe empty-bootstrap reminder", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      writers: { stderr: stderr.writer },
    });
    renderer.renderEvent({
      type: "sandbox-preparing",
      image: "example/sandbox:1",
      bootstrapCount: 0,
    });
    renderer.renderEvent({ type: "sandbox-ready" });

    expect(stderr.text()).toBe(
      "Sandbox: example/sandbox:1\n" +
        "Bootstrap: none configured\n" +
        'Tip: agentj config add sandbox.bootstrap "<project setup command>"\n' +
        "Bootstrap: complete\n",
    );
  });

  test("renders local workspace ownership and completion", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      writers: { stderr: stderr.writer },
    });
    renderer.renderEvent({
      type: "local-workspace",
      root: "/repo",
      branch: "feature/local",
      status: "2 files changed",
    });
    renderer.renderEvent({
      type: "local-complete",
      session: { ...SESSION, mode: "local" },
    });
    expect(stderr.text()).toContain("Workspace: local\n");
    expect(stderr.text()).toContain("Root: /repo\n");
    expect(stderr.text()).toContain("Git: feature/local · 2 files changed\n");
    expect(stderr.text()).toContain("Workspace: validated changes left in local checkout\n");
  });

  test("renders only bootstrap count and safe setup failure metadata", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      writers: { stderr: stderr.writer },
    });
    renderer.renderEvent({
      type: "sandbox-preparing",
      image: "example/sandbox:1",
      bootstrapCount: 2,
    });
    renderer.renderEvent({
      type: "sandbox-failed",
      error: "Sandbox bootstrap command 2 failed with exit code 127.",
    });

    expect(stderr.text()).toContain("Bootstrap: 2 commands configured\n");
    expect(stderr.text()).toContain(
      "Sandbox setup failed: Sandbox bootstrap command 2 failed with exit code 127.\n",
    );
    expect(stderr.text()).not.toContain("curl secret installer");
  });

  test("renders canonical-base warnings and recovery commits", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      writers: { stderr: stderr.writer },
    });
    const session = {
      ...SESSION,
      baseWarning: "local main diverges from origin/main; using shared remote baseline",
    };
    renderer.renderEvent({ type: "session-created", session });
    renderer.renderEvent({
      type: "build-blocked",
      session,
      reason: "a build tool failed",
      recoveryCommitSha: "def456",
    });

    expect(stderr.text()).toContain(
      "Warning: local main diverges from origin/main; using shared remote baseline",
    );
    expect(stderr.text()).toContain("Build blocked: a build tool failed");
    expect(stderr.text()).toContain("Recovery: def456 on feat/simple-tui");
  });

  test("shows tool activity, truncates payloads at the configured cap, and stays colorless when forced off", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      maxPayloadLength: 18,
      writers: {
        stderr: stderr.writer,
      },
    });

    renderer.renderEvent(toolCall({ path: "a".repeat(40) }));
    renderer.renderEvent(toolResult({ text: "b".repeat(40) }));

    const output = stderr.text();
    expect(output).toContain("Tool: read_file ");
    expect(output).toContain("Tool result: read_file ");
    expect(output).toContain("…");
    expect(output).not.toContain("\u001b[");
  });

  test("renders circular payload details without throwing", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      maxPayloadLength: 200,
      writers: {
        stderr: stderr.writer,
      },
    });

    const payload: Record<string, unknown> = { step: "tool-call" };
    payload.self = payload;
    Object.defineProperty(payload, "bad", {
      enumerable: true,
      get() {
        throw new Error("bad getter");
      },
    });

    expect(() => renderer.renderEvent(toolCall(payload))).not.toThrow();

    const output = stderr.text();
    expect(output).toContain("[Circular]");
    expect(output).toContain("[Thrown Error: bad getter]");
  });

  test("sends result output to stdout and commit outcomes to stderr", () => {
    const stdout = createMemoryWriter();
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      writers: {
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    });

    renderer.renderEvent({
      type: "result",
      session: SESSION,
      result: RESULT,
    });
    renderer.renderEvent({
      type: "commit",
      session: SESSION,
      result: RESULT,
      message: "agentj: complete task",
      sha: "abc1234",
    });
    renderer.renderEvent({
      type: "commit",
      session: SESSION,
      result: RESULT,
      message: "agentj: complete task",
      sha: null,
    });

    expect(stdout.text()).toBe("Result\nDone.\n");
    expect(stderr.text()).toContain("Commit: abc1234 — agentj: complete task\n");
    expect(stderr.text()).toContain("Commit: no changes\n");
  });

  test("writes generation, commit, and abort outcomes to stderr without rollback or preservation claims", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      writers: {
        stderr: stderr.writer,
      },
    });

    const outcomes: TaskRunOutcome[] = [
      {
        kind: "generation-error",
        session: SESSION,
        error: new Error("model offline"),
      },
      {
        kind: "commit-error",
        session: SESSION,
        result: RESULT,
        error: new Error("commit failed"),
      },
      {
        kind: "aborted",
        session: SESSION,
        error: new Error("aborted"),
      },
    ];

    for (const outcome of outcomes) {
      renderer.renderOutcome(outcome);
    }

    const output = stderr.text();
    expect(output).toContain("Generation failed: Error: model offline\n");
    expect(output).toContain("Commit failed: Error: commit failed\n");
    expect(output).toContain("Aborted: generation stopped before commit\n");
    expect(output).toContain(
      "Last known session: session-123 | feat/simple-tui from main @ /tmp/session-123\n",
    );
    expect(output.toLowerCase()).not.toContain("rollback");
    expect(output.toLowerCase()).not.toContain("preserv");
  });

  test("auto color follows tty state, while false disables ansi even on tty", () => {
    const autoStderr = createMemoryWriter();
    const autoRenderer = createTranscriptRenderer({
      task: "task",
      color: "auto",
      isTty: true,
      writers: {
        stderr: autoStderr.writer,
      },
    });

    autoRenderer.renderPrompt();
    expect(autoStderr.text()).toContain("\u001b[");

    const forcedOffStderr = createMemoryWriter();
    const forcedOffRenderer = createTranscriptRenderer({
      task: "task",
      color: false,
      isTty: true,
      writers: {
        stderr: forcedOffStderr.writer,
      },
    });

    forcedOffRenderer.renderPrompt();
    expect(forcedOffStderr.text()).toBe("Prompt: task\n");
    expect(forcedOffStderr.text()).not.toContain("\u001b[");
  });

  test("renders append-only planning subagent lifecycle events without a TTY", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      isTty: false,
      writers: { stderr: stderr.writer },
    });
    renderer.renderEvent(dagStarted());
    renderer.renderEvent({
      type: "subagent-progress",
      session: SESSION,
      progress: { type: "task-started", id: "1.1", lane: 1, title: "Map modules", startedAt: 1000 },
    });
    renderer.renderEvent({
      type: "subagent-progress",
      session: SESSION,
      progress: {
        type: "task-completed",
        id: "1.1",
        lane: 1,
        title: "Map modules",
        elapsedMs: 1800,
      },
    });
    renderer.renderEvent({
      type: "subagent-progress",
      session: SESSION,
      progress: { type: "dag-completed", elapsedMs: 1800 },
    });

    const output = stderr.text();
    expect(output).toContain("Subagents: Launch DAG · 2 workers · concurrency 2");
    expect(output).toContain("2  Command design · waits on: 1");
    expect(output).toContain("Subagent: 1.1 Map modules: started");
    expect(output).toContain("Subagent: 1.1 Map modules: completed in 1.8s");
    expect(output).toContain("Subagents: DAG complete in 1.8s");
    expect(output).not.toContain("\u001b[");
  });

  test("repaints a compact TTY DAG ledger and settles running rows", () => {
    const stderr = createMemoryWriter();
    const renderer = createTranscriptRenderer({
      task: "task",
      color: false,
      isTty: true,
      terminalWidth: 54,
      spinnerIntervalMs: 60_000,
      now: () => 2200,
      writers: { stderr: stderr.writer },
    });
    renderer.renderEvent(dagStarted());
    renderer.renderEvent({
      type: "subagent-progress",
      session: SESSION,
      progress: { type: "task-started", id: "1.1", lane: 1, title: "Map modules", startedAt: 1000 },
    });
    renderer.renderEvent({
      type: "subagent-progress",
      session: SESSION,
      progress: {
        type: "task-completed",
        id: "1.1",
        lane: 1,
        title: "Map modules",
        elapsedMs: 1200,
      },
    });
    renderer.renderEvent({
      type: "subagent-progress",
      session: SESSION,
      progress: { type: "dag-completed", elapsedMs: 1200 },
    });

    const output = stderr.text();
    expect(output).toContain("Subagents: Launch DAG");
    expect(output).toContain("◐ 1.1 Map modules  1.2s");
    expect(output).toContain("✓ 1.1 Map modules  1.2s");
    expect(output).toContain("\u001b[");
  });
});
