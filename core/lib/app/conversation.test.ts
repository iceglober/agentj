import { describe, expect, test } from "bun:test";
import type { Agent } from "../agent";
import type { RunResult } from "../llm";
import type { Sandbox } from "../sandbox";
import type { Session } from "../session";
import {
  type ConversationDependencies,
  type ConversationEvent,
  isExplicitApproval,
  runAgentConversation,
} from "./conversation";

const result = (text: string): RunResult => ({
  text,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

function fixture(plans: string[], build = "built") {
  let planIndex = 0;
  const purposes: string[] = [];
  const commits: string[] = [];
  let sessionDisposed = 0;
  let sandboxDisposed = 0;
  const sandbox = {
    async executeCommand() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFiles() {},
    async [Symbol.asyncDispose]() {
      sandboxDisposed += 1;
    },
  } as Sandbox & AsyncDisposable;
  const session = {
    id: "session-1",
    path: "/workspace/session-1",
    branch: "session/session-1",
    base: "main",
    async status() {
      return "";
    },
    async diff() {
      return "";
    },
    async log() {
      return "";
    },
    async commitAll(message: string) {
      commits.push(message);
      return "abc123";
    },
    async dispose() {},
    async [Symbol.asyncDispose]() {
      sessionDisposed += 1;
    },
  } satisfies Session;
  const dependencies: ConversationDependencies = {
    async createSandbox() {
      return sandbox;
    },
    async createSession() {
      return session;
    },
    async createAgent({ purpose }) {
      purposes.push(purpose);
      return {
        composed: {} as Agent["composed"],
        async generate(_prompt, options) {
          if (purpose === "planner") return result(plans[planIndex++] ?? plans.at(-1)!);
          await options?.onStep?.({
            toolCalls: [{ name: "bash", input: { command: "bun test" } }],
            toolResults: [{ name: "bash", output: { exitCode: 0 } }],
          });
          return result(
            JSON.stringify({
              status: "done",
              summary: build,
              changes: ["changed files"],
              validation: [{ command: "bun test", outcome: "passed", evidence: "tests pass" }],
              openQuestions: [],
            }),
          );
        },
      };
    },
  };
  return {
    dependencies,
    purposes,
    commits,
    disposed: () => ({ session: sessionDisposed, sandbox: sandboxDisposed }),
  };
}

describe("runAgentConversation", () => {
  test("emits sandbox preparation before session creation", async () => {
    const f = fixture(["Plan"]);
    f.dependencies.describeSandbox = async () => ({
      image: "example/sandbox:1",
      bootstrapCount: 2,
    });
    const events: ConversationEvent[] = [];
    await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      onEvent(event) {
        events.push(event);
      },
    });

    expect(events.slice(0, 3)).toEqual([
      { type: "sandbox-preparing", image: "example/sandbox:1", bootstrapCount: 2 },
      { type: "sandbox-ready" },
      expect.objectContaining({ type: "session-created" }),
    ]);
  });

  test("runs project setup after workspace creation and before planning", async () => {
    const f = fixture(["Plan"]);
    f.dependencies.setupWorkspace = async () => 1;
    const events: ConversationEvent[] = [];
    await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      onEvent(event) {
        events.push(event);
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "project-setup",
      "phase",
      "plan",
      "phase",
    ]);
  });

  test("reports sandbox setup failure before session or model work", async () => {
    let sessionCreates = 0;
    let agentCreates = 0;
    const events: ConversationEvent[] = [];
    const outcome = await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: {
        async describeSandbox() {
          return { image: "example/sandbox:1", bootstrapCount: 1 };
        },
        async createSandbox() {
          throw new Error("Sandbox bootstrap command 1 failed with exit code 127.");
        },
        async createSession() {
          sessionCreates += 1;
          throw new Error("unexpected");
        },
        async createAgent() {
          agentCreates += 1;
          throw new Error("unexpected");
        },
      },
      onEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      { type: "sandbox-preparing", image: "example/sandbox:1", bootstrapCount: 1 },
      {
        type: "sandbox-failed",
        error: "Sandbox bootstrap command 1 failed with exit code 127.",
      },
    ]);
    expect(outcome).toMatchObject({ kind: "generation-error", session: undefined });
    expect(sessionCreates).toBe(0);
    expect(agentCreates).toBe(0);
  });

  test("returns a plan without editing or committing when input is unavailable", async () => {
    const f = fixture(["Plan one"]);
    const events: ConversationEvent[] = [];
    const outcome = await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      onEvent(event) {
        events.push(event);
      },
    });

    expect(outcome.kind).toBe("plan-ready");
    expect(f.purposes).toEqual(["planner"]);
    expect(f.commits).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "phase",
      "plan",
      "phase",
    ]);
    expect(f.disposed()).toEqual({ session: 1, sandbox: 1 });
  });

  test("revises after feedback and builds only after explicit approval", async () => {
    const f = fixture(["Draft", "Revised"], "Implemented");
    const messages = ["also cover mobile", "proceed"];
    const events: ConversationEvent[] = [];
    const outcome = await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      nextUserMessage: async () => messages.shift() ?? null,
      onEvent(event) {
        events.push(event);
      },
    });

    expect(outcome).toMatchObject({ kind: "success", commitSha: "abc123" });
    expect(f.purposes).toEqual(["planner", "builder"]);
    expect(f.commits).toEqual(["agentj: change it"]);
    expect(events.filter((event) => event.type === "plan").map((event) => event.text)).toEqual([
      "Draft",
      "Revised",
    ]);
    expect(events.map((event) => event.type)).toContain("result");
    expect(events.map((event) => event.type)).toContain("commit");
  });

  test("forwards planner subagent progress with the active session identity", async () => {
    const f = fixture(["Plan"]);
    const originalCreateAgent = f.dependencies.createAgent;
    f.dependencies.createAgent = async (args) => {
      const agent = await originalCreateAgent(args);
      if (args.purpose !== "planner") return agent;
      return {
        ...agent,
        async generate(prompt, options) {
          await args.onPlanningProgress?.({
            type: "dag-started",
            concurrency: 2,
            startedAt: 1,
            lanes: [
              {
                id: 1,
                title: "Research",
                waitsOn: [],
                tasks: [{ id: "1.1", title: "Inspect" }],
              },
            ],
          });
          await args.onPlanningProgress?.({ type: "dag-completed", elapsedMs: 2 });
          return agent.generate(prompt, options);
        },
      };
    };
    const events: ConversationEvent[] = [];
    await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      onEvent(event) {
        events.push(event);
      },
    });
    const progress = events.filter((event) => event.type === "subagent-progress");
    expect(progress.map((event) => event.progress.type)).toEqual(["dag-started", "dag-completed"]);
    expect(progress.every((event) => event.session.id === "session-1")).toBe(true);
  });

  test("turns an empty builder result into a recovery commit instead of success", async () => {
    const f = fixture(["Plan"]);
    const originalCreateAgent = f.dependencies.createAgent;
    f.dependencies.createAgent = async (args) => {
      if (args.purpose === "planner") return originalCreateAgent(args);
      return {
        composed: {} as Agent["composed"],
        async generate() {
          return result("");
        },
      };
    };
    const events: ConversationEvent[] = [];
    const outcome = await runAgentConversation("change it", {
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      nextUserMessage: async () => "proceed",
      onEvent(event) {
        events.push(event);
      },
    });

    expect(outcome).toMatchObject({
      kind: "build-blocked",
      reason: "builder returned an empty result",
      recoveryCommitSha: "abc123",
    });
    expect(f.commits).toEqual(["agentj recovery: change it"]);
    expect(events.map((event) => event.type)).not.toContain("commit");
    expect(events.map((event) => event.type)).toContain("build-blocked");
  });
});

test("approval matching is explicit and conservative", () => {
  expect(isExplicitApproval("Proceed.")).toBe(true);
  expect(isExplicitApproval("implement the plan")).toBe(true);
  expect(isExplicitApproval("looks good, but change the tests")).toBe(false);
  expect(isExplicitApproval("yes")).toBe(false);
});
