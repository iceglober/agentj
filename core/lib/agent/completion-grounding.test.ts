import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { GenerateRequest, RunResult, ToolSet } from "../llm";
import type { TodoList } from "../todos";
import {
  claimsActiveDeferredWork,
  generateWithGroundedCompletion,
  hasAnyToolCall,
  hasStartedBackgroundJob,
} from "./completion-grounding";

const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const tools: ToolSet = {
  run_background_job: {
    description: "start a job",
    inputSchema: z.object({}),
    execute: async () => "",
  },
};

const report = (summary: string, status = "blocked"): string =>
  JSON.stringify({ status, summary, changes: [], validation: [], openQuestions: [] });

const doneReport = (summary: string): string =>
  JSON.stringify({
    status: "done",
    summary,
    changes: ["edited x"],
    validation: [{ command: "bun test", outcome: "passed", evidence: "ok" }],
    openQuestions: [],
  });

const runJobStep = () => ({
  toolCalls: [{ name: "run_background_job", input: {} }],
  toolResults: [
    {
      name: "run_background_job",
      output: "Started background job j4 (build). Do not wait for it.",
    },
  ],
});

const editStep = () => ({
  toolCalls: [{ name: "edit", input: {} }],
  toolResults: [{ name: "edit", output: "applied" }],
});

const result = (text: string, overrides: Partial<RunResult> = {}): RunResult => ({
  text,
  steps: [],
  usage,
  ...overrides,
});

describe("claimsActiveDeferredWork", () => {
  test("recognizes active external monitoring but not waiting for user approval", () => {
    expect(
      claimsActiveDeferredWork(
        report("Monitoring the release workflow; it will merge when ready."),
      ),
    ).toBe(true);
    expect(claimsActiveDeferredWork(report("Awaiting user approval before a merge."))).toBe(false);
    expect(claimsActiveDeferredWork("I cannot monitor CI from this session.")).toBe(false);
  });
});

describe("hasStartedBackgroundJob", () => {
  test("requires the existing run_background_job started-ID result", () => {
    expect(hasStartedBackgroundJob(result("", { steps: [runJobStep()] }))).toBe(true);
    // An "unavailable" run_background_job result is not a started job.
    expect(
      hasStartedBackgroundJob(
        result("", {
          steps: [
            {
              toolCalls: [{ name: "run_background_job", input: {} }],
              toolResults: [
                { name: "run_background_job", output: "Background jobs are unavailable." },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("hasAnyToolCall", () => {
  test("is false for a zero-tool turn and true once any tool is called", () => {
    expect(hasAnyToolCall(result(doneReport("done")))).toBe(false);
    expect(hasAnyToolCall(result(doneReport("done"), { steps: [editStep()] }))).toBe(true);
  });
});

describe("generateWithGroundedCompletion — background jobs", () => {
  const request: GenerateRequest = { instructions: "rules", prompt: "wait for CI", tools };

  test("requires a started job before accepting an in-progress report", async () => {
    let calls = 0;
    const output = await generateWithGroundedCompletion(
      {
        async generate() {
          calls += 1;
          return calls === 1
            ? result(report("Waiting for a result.", "in_progress"))
            : result(report("Job j4 is running.", "in_progress"), { steps: [runJobStep()] });
        },
      },
      request,
    );

    expect(calls).toBe(2);
    expect(output.text).toContain("Job j4 is running.");
  });

  test("retries one false monitoring claim with run_background_job forced first", async () => {
    const requests: GenerateRequest[] = [];
    const runtime = {
      async generate(next: GenerateRequest) {
        requests.push(next);
        return requests.length === 1
          ? result(report("Monitoring CI checks now."), { messages: [{ role: "assistant" }] })
          : result(report("Started monitoring."), {
              steps: [runJobStep()],
              messages: [{ role: "assistant" }, { role: "tool" }],
            });
      },
    };

    const output = await generateWithGroundedCompletion(runtime, request);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      requiredFirstTool: "run_background_job",
      messages: [{ role: "assistant" }],
    });
    expect(output.steps).toHaveLength(1);
    expect(output.usage).toEqual({ inputTokens: 2, outputTokens: 4, totalTokens: 6 });
    expect(output.text).toContain("Started monitoring.");
  });

  test("does not retry a verified run_background_job start", async () => {
    let calls = 0;
    const runtime = {
      async generate() {
        calls += 1;
        return result(report("Monitoring CI checks now."), { steps: [runJobStep()] });
      },
    };

    await generateWithGroundedCompletion(runtime, request);
    expect(calls).toBe(1);
  });

  test("replaces an unverified claim with an honest failure when no runner exists", async () => {
    const output = await generateWithGroundedCompletion(
      { generate: async () => result(report("Monitoring CI checks now.")) },
      { ...request, tools: {} },
    );

    expect(output.text).toContain("No background job was started");
    expect(output.text).toContain("No background job is active");
  });

  test("returns an honest failure after one forced call that does not start a job", async () => {
    let calls = 0;
    const output = await generateWithGroundedCompletion(
      {
        async generate() {
          calls += 1;
          return result(report("Monitoring CI checks now."));
        },
      },
      request,
    );

    expect(calls).toBe(2);
    expect(output.text).toContain("No background job was started");
    expect(output.text).toContain("not monitoring");
  });
});

describe("generateWithGroundedCompletion — open todos", () => {
  const request: GenerateRequest = { instructions: "rules", prompt: "finish it", tools };

  test("retries with the opaque continuation until todos are completed", async () => {
    let items: TodoList = [{ id: "ship", text: "Ship the change", status: "in_progress" }];
    const requests: GenerateRequest[] = [];
    const runtime = {
      async generate(next: GenerateRequest) {
        requests.push(next);
        if (requests.length === 1)
          return result("I am done.", { messages: [{ role: "assistant" }] });
        items = [{ ...items[0]!, status: "completed" }];
        return result(doneReport("Finished and validated."), {
          steps: [editStep()],
          messages: [{ role: "assistant" }, { role: "tool" }],
        });
      },
    };

    const output = await generateWithGroundedCompletion(runtime, request, {
      todos: { list: () => items, replace: async () => {} },
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([{ role: "assistant" }]);
    expect(requests[1]?.prompt).toContain("session still has pending");
    expect(output.text).toContain("Finished and validated.");
  });

  test("allows a real background job to own open deferred work", async () => {
    let calls = 0;
    const output = await generateWithGroundedCompletion(
      {
        async generate() {
          calls += 1;
          return result(report("Started the deployment monitor."), { steps: [runJobStep()] });
        },
      },
      request,
      {
        todos: {
          list: () => [{ id: "deploy", text: "Monitor deploy", status: "pending" }],
          replace: async () => {},
        },
      },
    );

    expect(calls).toBe(1);
    expect(output.text).toContain("Started the deployment monitor.");
  });

  test("returns an honest failure when a retry leaves todos open without a blocker", async () => {
    const output = await generateWithGroundedCompletion(
      { generate: async () => result("Stopped early.") },
      request,
      {
        todos: {
          list: () => [{ id: "test", text: "Run tests", status: "pending" }],
          replace: async () => {},
        },
      },
    );

    expect(output.text).toContain('"status":"failed"');
    expect(output.text).toContain("open session todos");
  });

  test("allows an explicit blocker with open todos", async () => {
    let calls = 0;
    const output = await generateWithGroundedCompletion(
      {
        async generate() {
          calls += 1;
          return result(report("The model provider is unavailable.", "blocked"));
        },
      },
      request,
      {
        todos: {
          list: () => [{ id: "test", text: "Run tests", status: "pending" }],
          replace: async () => {},
        },
      },
    );

    expect(calls).toBe(1);
    expect(output.text).toContain("model provider is unavailable");
  });
});

describe("generateWithGroundedCompletion — fabricated done reports", () => {
  const request: GenerateRequest = { instructions: "rules", prompt: "implement it", tools };

  test("retries a status=done report that called no tools, then accepts real work", async () => {
    const requests: GenerateRequest[] = [];
    const runtime = {
      async generate(next: GenerateRequest) {
        requests.push(next);
        return requests.length === 1
          ? result(doneReport("2745 tests passed."), { messages: [{ role: "assistant" }] })
          : result(doneReport("Implemented and validated."), {
              steps: [editStep()],
              messages: [{ role: "assistant" }, { role: "tool" }],
            });
      },
    };

    const output = await generateWithGroundedCompletion(runtime, request);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.requiredFirstTool).toBeUndefined();
    expect(output.steps).toHaveLength(1);
    expect(output.text).toContain("Implemented and validated.");
  });

  test("does not retry a status=done report backed by real tool calls", async () => {
    let calls = 0;
    const runtime = {
      async generate() {
        calls += 1;
        return result(doneReport("Done for real."), { steps: [editStep()] });
      },
    };

    const output = await generateWithGroundedCompletion(runtime, request);
    expect(calls).toBe(1);
    expect(output.text).toContain("Done for real.");
  });

  test("replaces a still-fabricated done with an explicit failure report", async () => {
    let calls = 0;
    const output = await generateWithGroundedCompletion(
      {
        async generate() {
          calls += 1;
          return result(doneReport("All green."));
        },
      },
      request,
    );

    expect(calls).toBe(2);
    expect(output.text).toContain('"status":"failed"');
    expect(output.text).toContain("without running any tool");
  });

  test("leaves blocked and failed reports untouched", async () => {
    let calls = 0;
    const runtime = {
      async generate() {
        calls += 1;
        return result(report("Cannot proceed.", "blocked"));
      },
    };

    const output = await generateWithGroundedCompletion(runtime, request);
    expect(calls).toBe(1);
    expect(output.text).toContain("Cannot proceed.");
  });
});
