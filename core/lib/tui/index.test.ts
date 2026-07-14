import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import type { TaskRunEvent, TaskRunOutcome, TaskRunSessionIdentity } from "../app/run";
import {
  createPromptsPromptUi,
  createTranscriptRenderer,
  type PromptRunner,
  safeRenderJson,
  type TerminalWriter,
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

describe("createPromptsPromptUi", () => {
  test("submits a trimmed task and passes configured prompt IO through", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let capturedQuestion: Parameters<PromptRunner>[0] | undefined;

    const ui = createPromptsPromptUi({
      stdin,
      stdout,
      prompts: (async (question) => {
        capturedQuestion = question;
        return { task: "  fix the flaky test  " };
      }) as PromptRunner,
    });

    await expect(ui.askTask()).resolves.toBe("fix the flaky test");

    expect(capturedQuestion).toMatchObject({
      type: "text",
      name: "task",
      message:
        "AgentJ runs one task, then exits. What should it do?\nExamples: fix a failing test; explain a module boundary; add a targeted regression test.",
      hint: "Describe one coding task.",
      stdin,
      stdout,
    });
  });

  test("returns null when isInteractive is false and never invokes the prompt runner", async () => {
    let invoked = false;

    const ui = createPromptsPromptUi({
      isInteractive: false,
      prompts: (async () => {
        invoked = true;
        return { task: "should not reach" };
      }) as PromptRunner,
    });

    await expect(ui.askTask()).resolves.toBeNull();
    expect(invoked).toBe(false);
  });

  test("returns null when stdin is already destroyed and never invokes the prompt runner", async () => {
    const stdin = new PassThrough();
    stdin.destroy();
    let invoked = false;

    const ui = createPromptsPromptUi({
      stdin,
      prompts: (async () => {
        invoked = true;
        return { task: "should not reach" };
      }) as PromptRunner,
    });

    await expect(ui.askTask()).resolves.toBeNull();
    expect(invoked).toBe(false);
  });

  test("returns null when stdin is already readableEnded and never invokes the prompt runner", async () => {
    const stdin = new PassThrough();
    stdin.push(null); // signal EOF
    // drain the stream so readableEnded becomes true
    for await (const _ of stdin) {
      /* consume */
    }
    let invoked = false;

    const ui = createPromptsPromptUi({
      stdin,
      prompts: (async () => {
        invoked = true;
        return { task: "should not reach" };
      }) as PromptRunner,
    });

    await expect(ui.askTask()).resolves.toBeNull();
    expect(invoked).toBe(false);
  });

  test("rejects empty input, returns null on cancel, and treats EOF as null", async () => {
    let validate: ((value: unknown) => boolean | string) | undefined;

    const ui = createPromptsPromptUi({
      prompts: (async (question, options) => {
        const single = Array.isArray(question) ? question[0] : question;
        validate = single.validate as typeof validate;
        if (options?.onCancel) {
          (options.onCancel as (...args: unknown[]) => void)(single);
        }
        return { task: "ignored" };
      }) as PromptRunner,
    });

    expect(validate).toBeUndefined();
    await expect(ui.askTask()).resolves.toBeNull();

    expect(validate?.("   ")).toBe("Enter a task, or press Ctrl+C to cancel.");
    expect(validate?.("  explain the boundary  ")).toBe(true);

    const eofUi = createPromptsPromptUi({
      prompts: (async () => ({ task: undefined })) as PromptRunner,
    });

    await expect(eofUi.askTask()).resolves.toBeNull();
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
});
