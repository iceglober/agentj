import { describe, expect, test } from "bun:test";
import type { RunResult } from "../llm";
import type {
  ChildSession,
  ChildSessionFinalizeRequest,
  ChildSessionFinalizeResult,
} from "../session";
import type {
  CreateChildAgentArgs,
  CreateChildSessionArgs,
  SubagentTask,
  SubagentTaskResult,
  SubagentToolResult,
} from "./delegate";
import { createSubagentTool } from "./delegate";

const PARENT_REF = "refs/remotes/origin/main";

function makeTask(id: string): SubagentTask {
  return {
    id,
    prompt: `prompt ${id}`,
    commitMessage: `commit ${id}`,
  };
}

function makeRunResult(text: string): RunResult {
  return {
    text,
    steps: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBarrier(target: number) {
  const done = deferred<void>();
  let count = 0;
  return {
    hit() {
      count += 1;
      if (count >= target) done.resolve();
    },
    wait() {
      return done.promise;
    },
    get count() {
      return count;
    },
  };
}

function makeAbortError(message: string) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

type SubagentTool = ReturnType<typeof createSubagentTool>;
type ExecuteSubagentToolInput = {
  tasks: SubagentTask[];
  concurrency: number;
};

async function executeSubagentTool(
  tool: SubagentTool,
  input: ExecuteSubagentToolInput,
  options?: { abortSignal?: AbortSignal },
): Promise<SubagentToolResult> {
  return (await tool.execute(tool.inputSchema.parse(input), options)) as SubagentToolResult;
}

type SessionWithCalls = ChildSession & {
  finalizeCalls: ChildSessionFinalizeRequest[];
};

function makeSession(
  id: string,
  finalizeImpl: (
    request: ChildSessionFinalizeRequest,
  ) => Promise<ChildSessionFinalizeResult> | ChildSessionFinalizeResult,
): SessionWithCalls {
  const finalizeCalls: ChildSessionFinalizeRequest[] = [];
  return {
    id,
    path: `/child/${id}`,
    branch: `agent/${id}`,
    base: `base-${id}`,
    parentRef: PARENT_REF,
    async finalize(request) {
      finalizeCalls.push(request);
      return await finalizeImpl(request);
    },
    async status() {
      return "";
    },
    async diff() {
      return "";
    },
    async log() {
      return "";
    },
    async commitAll() {
      return `commit-${id}`;
    },
    async dispose() {
      return;
    },
    async [Symbol.asyncDispose]() {
      return;
    },
    finalizeCalls,
  } as SessionWithCalls;
}

function changedResult(
  session: Pick<ChildSession, "id" | "path" | "branch" | "base" | "parentRef">,
  overrides: Partial<Extract<ChildSessionFinalizeResult, { outcome: "changed" }>> = {},
): Extract<ChildSessionFinalizeResult, { outcome: "changed" }> {
  return {
    outcome: "changed",
    id: session.id,
    path: session.path,
    branch: session.branch,
    base: session.base,
    parentRef: session.parentRef,
    head: overrides.head ?? `head-${session.id}`,
    status: overrides.status ?? "",
    commit: overrides.commit ?? `commit-${session.id}`,
    worktreeRemoved: true,
    branchDeleted: false,
    preserved: false,
    ...overrides,
  };
}

function cleanResult(
  session: Pick<ChildSession, "id" | "path" | "branch" | "base" | "parentRef">,
): Extract<ChildSessionFinalizeResult, { outcome: "clean" }> {
  return {
    outcome: "clean",
    id: session.id,
    path: session.path,
    branch: session.branch,
    base: session.base,
    parentRef: session.parentRef,
    head: `head-${session.id}`,
    status: "",
    commit: null,
    worktreeRemoved: true,
    branchDeleted: true,
    preserved: false,
  };
}

function preservedResult(
  session: Pick<ChildSession, "id" | "path" | "branch" | "base" | "parentRef">,
  reason: "failure" | "aborted" | "uncertain",
  overrides: Partial<Extract<ChildSessionFinalizeResult, { outcome: "preserved" }>> = {},
): Extract<ChildSessionFinalizeResult, { outcome: "preserved" }> {
  return {
    outcome: "preserved",
    reason,
    id: session.id,
    path: session.path,
    branch: session.branch,
    base: session.base,
    parentRef: session.parentRef,
    head: overrides.head ?? `head-${session.id}`,
    status: overrides.status ?? "M changed.txt",
    commit: overrides.commit ?? null,
    worktreeRemoved: false,
    branchDeleted: false,
    preserved: true,
    ...overrides,
  };
}

describe("createSubagentTool", () => {
  test("runs tasks concurrently in distinct child roots, caps active lanes, and keeps results in input order", async () => {
    const sessions = new Map<string, SessionWithCalls>();
    const sessionCalls: CreateChildSessionArgs[] = [];
    const childCalls: CreateChildAgentArgs[] = [];
    const firstTwoStarted = makeBarrier(2);
    const allThreeStarted = makeBarrier(3);
    const releases = {
      one: deferred<void>(),
      two: deferred<void>(),
      three: deferred<void>(),
    };

    let active = 0;
    let maxActive = 0;

    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      maxConcurrency: 2,
      async createChildSession(args) {
        sessionCalls.push(args);
        const session = makeSession(args.id, () => changedResult(session));
        sessions.set(args.id, session);
        return session;
      },
      async createChildAgent(args) {
        childCalls.push(args);
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate(prompt) {
            expect(prompt).toBe(args.task.prompt);
            active += 1;
            maxActive = Math.max(maxActive, active);
            firstTwoStarted.hit();
            allThreeStarted.hit();
            try {
              await releases[args.task.id as keyof typeof releases].promise;
              return makeRunResult(`done ${args.task.id}`);
            } finally {
              active -= 1;
            }
          },
        };
      },
    });

    const run = executeSubagentTool(tool, {
      tasks: [makeTask("one"), makeTask("two"), makeTask("three")],
      concurrency: 3,
    });

    await firstTwoStarted.wait();
    expect(sessionCalls.map((call) => call.id)).toEqual(["one", "two"]);
    expect(childCalls.map((call) => call.task.id)).toEqual(["one", "two"]);
    expect(childCalls.map((call) => call.role)).toEqual(["delegate", "delegate"]);
    expect(childCalls.map((call) => call.root)).toEqual(["/child/one", "/child/two"]);
    expect(new Set(childCalls.map((call) => call.session.branch)).size).toBe(2);
    expect(maxActive).toBe(2);

    releases.two.resolve();
    await allThreeStarted.wait();
    expect(sessionCalls.map((call) => call.id)).toEqual(["one", "two", "three"]);
    expect(childCalls.map((call) => call.task.id)).toEqual(["one", "two", "three"]);
    expect(childCalls.map((call) => call.role)).toEqual(["delegate", "delegate", "delegate"]);
    expect(maxActive).toBe(2);

    releases.three.resolve();
    releases.one.resolve();

    const { results } = await run;
    expect(results.map((result) => result.id)).toEqual(["one", "two", "three"]);
    expect(results.map((result) => result.text)).toEqual(["done one", "done two", "done three"]);
    expect(results.map((result) => result.branch)).toEqual([
      "agent/one",
      "agent/two",
      "agent/three",
    ]);
  });

  test("changed success returns commit metadata and finalizes exactly once", async () => {
    let session!: SessionWithCalls;
    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession({ id }) {
        session = makeSession(id, (request) => {
          expect(request).toEqual({
            outcome: "success",
            commitMessage: "commit alpha",
          });
          return changedResult(session, {
            head: "aaaaaaaa",
            status: "",
            commit: "bbbbbbbb",
          });
        });
        return session;
      },
      async createChildAgent(args) {
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe("/child/alpha");
        return {
          async generate(prompt) {
            expect(prompt).toBe("prompt alpha");
            return makeRunResult(`result for ${args.task.id}`);
          },
        };
      },
    });

    const results: SubagentTaskResult[] = (
      await executeSubagentTool(tool, { tasks: [makeTask("alpha")], concurrency: 1 })
    ).results;

    expect(session.finalizeCalls).toEqual([{ outcome: "success", commitMessage: "commit alpha" }]);
    expect(results).toEqual([
      {
        index: 0,
        id: "alpha",
        outcome: "changed",
        branch: "agent/alpha",
        path: "/child/alpha",
        base: "base-alpha",
        commit: "bbbbbbbb",
        text: "result for alpha",
        error: null,
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: "aaaaaaaa",
          status: "",
          worktreeRemoved: true,
          branchDeleted: false,
        },
      },
    ]);
  });

  test("clean success maps correctly", async () => {
    let session!: SessionWithCalls;
    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession({ id }) {
        session = makeSession(id, () => cleanResult(session));
        return session;
      },
      async createChildAgent(args) {
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate() {
            return makeRunResult("nothing changed");
          },
        };
      },
    });

    const results: SubagentTaskResult[] = (
      await executeSubagentTool(tool, { tasks: [makeTask("clean")], concurrency: 1 })
    ).results;

    expect(session.finalizeCalls).toEqual([{ outcome: "success", commitMessage: "commit clean" }]);
    expect(results).toEqual([
      {
        index: 0,
        id: "clean",
        outcome: "clean",
        branch: "agent/clean",
        path: "/child/clean",
        base: "base-clean",
        commit: null,
        text: "nothing changed",
        error: null,
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: "head-clean",
          status: "",
          worktreeRemoved: true,
          branchDeleted: true,
        },
      },
    ]);
  });

  test("a throwing lane is preserved as failure while another lane succeeds", async () => {
    const sessions = new Map<string, SessionWithCalls>();

    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession({ id }) {
        const session = makeSession(id, (request) => {
          if (request.outcome === "success") return changedResult(session);
          expect(request).toEqual({ outcome: "failure", detail: "lane exploded" });
          return preservedResult(session, "failure", {
            detail: request.detail,
            status: "M failed.txt",
          });
        });
        sessions.set(id, session);
        return session;
      },
      async createChildAgent(args) {
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate() {
            if (args.task.id === "bad") throw new Error("lane exploded");
            return makeRunResult("good lane done");
          },
        };
      },
    });

    const results: SubagentTaskResult[] = (
      await executeSubagentTool(tool, {
        tasks: [makeTask("bad"), makeTask("good")],
        concurrency: 2,
      })
    ).results;

    expect(sessions.get("bad")?.finalizeCalls).toEqual([
      { outcome: "failure", detail: "lane exploded" },
    ]);
    expect(sessions.get("good")?.finalizeCalls).toEqual([
      { outcome: "success", commitMessage: "commit good" },
    ]);
    expect(results).toEqual([
      {
        index: 0,
        id: "bad",
        outcome: "failure",
        branch: "agent/bad",
        path: "/child/bad",
        base: "base-bad",
        commit: null,
        text: null,
        error: "lane exploded",
        recovery: {
          preserved: true,
          reason: "failure",
          parentRef: PARENT_REF,
          head: "head-bad",
          status: "M failed.txt",
          worktreeRemoved: false,
          branchDeleted: false,
        },
      },
      {
        index: 1,
        id: "good",
        outcome: "changed",
        branch: "agent/good",
        path: "/child/good",
        base: "base-good",
        commit: "commit-good",
        text: "good lane done",
        error: null,
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: "head-good",
          status: "",
          worktreeRemoved: true,
          branchDeleted: false,
        },
      },
    ]);
  });

  test("abort stops unclaimed lanes and preserves started lanes as aborted", async () => {
    const sessions = new Map<string, SessionWithCalls>();
    const sessionCalls: CreateChildSessionArgs[] = [];
    const childCalls: CreateChildAgentArgs[] = [];
    const started = makeBarrier(2);
    const controller = new AbortController();

    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      maxConcurrency: 2,
      async createChildSession(args) {
        sessionCalls.push(args);
        const session = makeSession(args.id, (request) => {
          expect(request).toEqual({ outcome: "aborted", detail: "manual abort" });
          if (request.outcome !== "aborted") {
            throw new Error(`unexpected finalize outcome: ${request.outcome}`);
          }
          return preservedResult(session, "aborted", {
            detail: request.detail,
            status: "M interrupted.txt",
          });
        });
        sessions.set(args.id, session);
        return session;
      },
      async createChildAgent(args) {
        childCalls.push(args);
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate(_prompt, opts) {
            started.hit();
            return await new Promise<RunResult>((_resolve, reject) => {
              if (opts?.abortSignal?.aborted) {
                reject(makeAbortError("manual abort"));
                return;
              }
              const onAbort = () => reject(makeAbortError("manual abort"));
              opts?.abortSignal?.addEventListener("abort", onAbort, { once: true });
            });
          },
        };
      },
    });

    const run = executeSubagentTool(
      tool,
      {
        tasks: [makeTask("one"), makeTask("two"), makeTask("three")],
        concurrency: 3,
      },
      { abortSignal: controller.signal },
    );

    await started.wait();
    controller.abort();
    const { results } = await run;

    expect(sessionCalls.map((call) => call.id)).toEqual(["one", "two"]);
    expect(childCalls.map((call) => call.task.id)).toEqual(["one", "two"]);
    expect(sessions.get("one")?.finalizeCalls).toEqual([
      { outcome: "aborted", detail: "manual abort" },
    ]);
    expect(sessions.get("two")?.finalizeCalls).toEqual([
      { outcome: "aborted", detail: "manual abort" },
    ]);
    expect(results).toEqual([
      {
        index: 0,
        id: "one",
        outcome: "aborted",
        branch: "agent/one",
        path: "/child/one",
        base: "base-one",
        commit: null,
        text: null,
        error: "manual abort",
        recovery: {
          preserved: true,
          reason: "aborted",
          parentRef: PARENT_REF,
          head: "head-one",
          status: "M interrupted.txt",
          worktreeRemoved: false,
          branchDeleted: false,
        },
      },
      {
        index: 1,
        id: "two",
        outcome: "aborted",
        branch: "agent/two",
        path: "/child/two",
        base: "base-two",
        commit: null,
        text: null,
        error: "manual abort",
        recovery: {
          preserved: true,
          reason: "aborted",
          parentRef: PARENT_REF,
          head: "head-two",
          status: "M interrupted.txt",
          worktreeRemoved: false,
          branchDeleted: false,
        },
      },
      {
        index: 2,
        id: "three",
        outcome: "aborted",
        branch: null,
        path: null,
        base: null,
        commit: null,
        text: null,
        error: "Aborted before this lane started.",
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: null,
          status: null,
          worktreeRemoved: null,
          branchDeleted: null,
        },
      },
    ]);
  });

  test("child-session creation failure produces one failed lane without canceling siblings", async () => {
    const childCalls: CreateChildAgentArgs[] = [];
    let goodSession!: SessionWithCalls;

    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession({ id }) {
        if (id === "broken") throw new Error("session create failed");
        goodSession = makeSession(id, () => changedResult(goodSession));
        return goodSession;
      },
      async createChildAgent(args) {
        childCalls.push(args);
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate() {
            return makeRunResult(`done ${args.task.id}`);
          },
        };
      },
    });

    const results: SubagentTaskResult[] = (
      await executeSubagentTool(tool, {
        tasks: [makeTask("broken"), makeTask("good")],
        concurrency: 2,
      })
    ).results;

    expect(childCalls.map((call) => call.task.id)).toEqual(["good"]);
    expect(goodSession.finalizeCalls).toEqual([
      { outcome: "success", commitMessage: "commit good" },
    ]);
    expect(results).toEqual([
      {
        index: 0,
        id: "broken",
        outcome: "failure",
        branch: null,
        path: null,
        base: null,
        commit: null,
        text: null,
        error: "session create failed",
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: null,
          status: null,
          worktreeRemoved: null,
          branchDeleted: null,
        },
      },
      {
        index: 1,
        id: "good",
        outcome: "changed",
        branch: "agent/good",
        path: "/child/good",
        base: "base-good",
        commit: "commit-good",
        text: "done good",
        error: null,
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: "head-good",
          status: "",
          worktreeRemoved: true,
          branchDeleted: false,
        },
      },
    ]);
  });

  test("a finalize throw keeps known lane metadata without overclaiming preservation", async () => {
    const sessions = new Map<string, SessionWithCalls>();

    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession({ id }) {
        const session = makeSession(id, () => {
          if (id === "boom") throw new Error("remove worktree failed");
          return changedResult(session);
        });
        sessions.set(id, session);
        return session;
      },
      async createChildAgent(args) {
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate() {
            return makeRunResult(`done ${args.task.id}`);
          },
        };
      },
    });

    const results: SubagentTaskResult[] = (
      await executeSubagentTool(tool, {
        tasks: [makeTask("boom"), makeTask("good")],
        concurrency: 2,
      })
    ).results;

    expect(sessions.get("boom")?.finalizeCalls).toEqual([
      { outcome: "success", commitMessage: "commit boom" },
    ]);
    expect(sessions.get("good")?.finalizeCalls).toEqual([
      { outcome: "success", commitMessage: "commit good" },
    ]);
    expect(results).toEqual([
      {
        index: 0,
        id: "boom",
        outcome: "failure",
        branch: "agent/boom",
        path: "/child/boom",
        base: "base-boom",
        commit: null,
        text: "done boom",
        error: "Session finalization failed: remove worktree failed",
        recovery: {
          preserved: false,
          reason: "uncertain",
          parentRef: PARENT_REF,
          head: null,
          status: null,
          worktreeRemoved: null,
          branchDeleted: null,
        },
      },
      {
        index: 1,
        id: "good",
        outcome: "changed",
        branch: "agent/good",
        path: "/child/good",
        base: "base-good",
        commit: "commit-good",
        text: "done good",
        error: null,
        recovery: {
          preserved: false,
          reason: null,
          parentRef: PARENT_REF,
          head: "head-good",
          status: "",
          worktreeRemoved: true,
          branchDeleted: false,
        },
      },
    ]);
  });

  test("child factory contract only supplies the delegate role", async () => {
    const roles: CreateChildAgentArgs["role"][] = [];

    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession({ id }) {
        const session = makeSession(id, () => changedResult(session));
        return session;
      },
      async createChildAgent(args) {
        roles.push(args.role);
        expect(args.role).toBe("delegate");
        expect(args.allowDelegation).toBe(false);
        expect(args.root).toBe(args.session.path);
        return {
          async generate() {
            return makeRunResult(`done ${args.task.id}`);
          },
        };
      },
    });

    await executeSubagentTool(tool, {
      tasks: [makeTask("one"), makeTask("two")],
      concurrency: 2,
    });

    expect(roles).toEqual(["delegate", "delegate"]);
    expect(new Set(roles)).toEqual(new Set(["delegate"]));
  });

  test("input schema rejects empty tasks and invalid concurrency", () => {
    const tool = createSubagentTool({
      parentRef: PARENT_REF,
      async createChildSession() {
        throw new Error("not used");
      },
      async createChildAgent() {
        throw new Error("not used");
      },
    });

    expect(tool.inputSchema.safeParse({ tasks: [], concurrency: 1 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ tasks: [makeTask("x")], concurrency: 0 }).success).toBe(
      false,
    );
    expect(tool.inputSchema.safeParse({ tasks: [makeTask("x")], concurrency: 1.5 }).success).toBe(
      false,
    );
  });
});
