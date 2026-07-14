import { describe, expect, test } from "bun:test";
import type { Agent } from "../agent";
import type { RunResult, RunStep } from "../llm";
import type { MetricsSink } from "../metrics";
import type { Sandbox } from "../sandbox";
import { type SecretStore, SecretStoreUnavailableError } from "../secrets";
import type { ChildSession, Session } from "../session";
import {
  createProductionTaskRunDependencies,
  type ProductionTaskRunDependencyOverrides,
  runAgentTask,
  type TaskRunDependencies,
  type TaskRunEvent,
} from "./run";

function makeRunResult(text: string, steps: RunStep[] = []): RunResult {
  return {
    text,
    steps,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

function makeAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

type SandboxWithCalls = Sandbox & {
  asyncDisposeCalls: number;
  disposeCalls: number;
};

function makeSandbox(options?: { asyncDisposeError?: Error }): SandboxWithCalls {
  let asyncDisposeCalls = 0;
  let disposeCalls = 0;

  const sandbox = {
    asyncDisposeCalls,
    disposeCalls,
    async [Symbol.asyncDispose]() {
      asyncDisposeCalls += 1;
      sandbox.asyncDisposeCalls = asyncDisposeCalls;
      if (options?.asyncDisposeError) {
        throw options.asyncDisposeError;
      }
    },
    async dispose() {
      disposeCalls += 1;
      sandbox.disposeCalls = disposeCalls;
    },
    async executeCommand() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFiles() {
      return;
    },
  } as unknown as SandboxWithCalls;

  return sandbox;
}

type SessionWithCalls = Session & {
  commitCalls: string[];
  asyncDisposeCalls: number;
  disposeCalls: number;
};

function makeSession(options?: {
  commitResult?: string | null;
  commitError?: Error;
  asyncDisposeError?: Error;
}): SessionWithCalls {
  const hasCommitResult = options && "commitResult" in options;
  const commitCalls: string[] = [];
  let asyncDisposeCalls = 0;
  let disposeCalls = 0;

  return {
    id: "session-1",
    path: "/tmp/session-1",
    branch: "agent/session-1",
    base: "origin/main",
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
      commitCalls.push(message);
      if (options?.commitError) {
        throw options.commitError;
      }

      return hasCommitResult ? options.commitResult! : "commit-sha-123";
    },
    async dispose() {
      disposeCalls += 1;
      this.disposeCalls = disposeCalls;
    },
    async [Symbol.asyncDispose]() {
      asyncDisposeCalls += 1;
      this.asyncDisposeCalls = asyncDisposeCalls;
      if (options?.asyncDisposeError) {
        throw options.asyncDisposeError;
      }
    },
    commitCalls,
    asyncDisposeCalls,
    disposeCalls,
  } as SessionWithCalls;
}

function makeAgent(generateImpl: Agent["generate"]): Agent {
  return {
    composed: {} as Agent["composed"],
    generate: generateImpl,
  };
}

function makeDependencies(options?: {
  sandbox?: SandboxWithCalls;
  session?: SessionWithCalls;
  agent?: Agent;
  createSandboxError?: Error;
  createSessionError?: Error;
  createAgentError?: Error;
  shouldIncludeToolResult?: TaskRunDependencies["shouldIncludeToolResult"];
}): TaskRunDependencies {
  const sandbox = options?.sandbox ?? makeSandbox();
  const session = options?.session ?? makeSession();
  const agent =
    options?.agent ??
    makeAgent(async () => {
      return makeRunResult("done");
    });

  return {
    async createSandbox() {
      if (options?.createSandboxError) {
        throw options.createSandboxError;
      }

      return sandbox;
    },
    async createSession() {
      if (options?.createSessionError) {
        throw options.createSessionError;
      }

      return session;
    },
    async createAgent() {
      if (options?.createAgentError) {
        throw options.createAgentError;
      }

      return agent;
    },
    shouldIncludeToolResult: options?.shouldIncludeToolResult,
  };
}

async function executeRun(
  task: string,
  dependencies: TaskRunDependencies,
  signal: AbortSignal = new AbortController().signal,
) {
  const events: TaskRunEvent[] = [];
  const outcome = await runAgentTask(task, {
    signal,
    dependencies,
    onEvent(event) {
      events.push(event);
    },
  });

  return { events, outcome };
}

describe("runAgentTask", () => {
  test("emits session, tool activity, result, and commit in order and returns the commit sha", async () => {
    const longTask = "ship ".repeat(30);
    const longInput = { prompt: "x".repeat(600) };
    const longOutput = { transcript: "y".repeat(900) };
    const longText = "z".repeat(1200);
    const sandbox = makeSandbox();
    const session = makeSession({ commitResult: "abc123" });
    const result = makeRunResult(longText);
    const agent = makeAgent(async (_task, options) => {
      await options?.onStep?.({
        toolCalls: [{ name: "bash", input: longInput }],
        toolResults: [{ name: "bash", output: longOutput }],
      });
      return result;
    });

    const { events, outcome } = await executeRun(
      longTask,
      makeDependencies({
        sandbox,
        session,
        agent,
        shouldIncludeToolResult: () => true,
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "tool-call",
      "tool-result",
      "result",
      "commit",
    ]);
    expect(events[0]).toEqual({
      type: "session-created",
      session: {
        id: "session-1",
        branch: "agent/session-1",
        base: "origin/main",
        path: "/tmp/session-1",
      },
    });
    expect(events[1]).toEqual({
      type: "tool-call",
      session: events[0]!.session,
      call: { name: "bash", input: longInput },
    });
    expect(events[2]).toEqual({
      type: "tool-result",
      session: events[0]!.session,
      result: { name: "bash", output: longOutput },
    });
    expect(events[3]).toEqual({
      type: "result",
      session: events[0]!.session,
      result,
    });
    expect(events[4]).toEqual({
      type: "commit",
      session: events[0]!.session,
      result,
      message: `agentj: ${longTask.slice(0, 72)}`,
      sha: "abc123",
    });
    expect((events[1] as Extract<TaskRunEvent, { type: "tool-call" }>).call.input).toEqual(
      longInput,
    );
    expect((events[2] as Extract<TaskRunEvent, { type: "tool-result" }>).result.output).toEqual(
      longOutput,
    );
    expect((events[3] as Extract<TaskRunEvent, { type: "result" }>).result.text).toBe(longText);
    expect(outcome).toEqual({
      kind: "success",
      session: events[0]!.session,
      result,
      commitSha: "abc123",
    });
    expect(session.commitCalls).toEqual([`agentj: ${longTask.slice(0, 72)}`]);
    expect(session.asyncDisposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);
    expect(sandbox.asyncDisposeCalls).toBe(1);
    expect(sandbox.disposeCalls).toBe(0);
  });

  test("returns success with null commit sha for a clean no-change commit", async () => {
    const result = makeRunResult("clean");
    const session = makeSession({ commitResult: null });

    const { events, outcome } = await executeRun(
      "clean task",
      makeDependencies({
        session,
        agent: makeAgent(async () => result),
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["session-created", "result", "commit"]);
    expect(events[2]).toEqual({
      type: "commit",
      session: events[0]!.session,
      result,
      message: "agentj: clean task",
      sha: null,
    });
    expect(outcome).toEqual({
      kind: "success",
      session: events[0]!.session,
      result,
      commitSha: null,
    });
  });

  test("uses the production-default tool-result filter when none is injected", async () => {
    const keptOutput = { subagents: "kept".repeat(200) };
    const droppedOutput = { stdout: "dropped".repeat(200) };

    const { events, outcome } = await executeRun(
      "filter task",
      makeDependencies({
        session: makeSession({ commitResult: null }),
        agent: makeAgent(async (_task, options) => {
          await options?.onStep?.({
            toolCalls: [],
            toolResults: [
              { name: "bash", output: droppedOutput },
              { name: "run_subagents", output: keptOutput },
            ],
          });
          return makeRunResult("filtered");
        }),
      }),
    );

    const toolResultEvents = events.filter(
      (event): event is Extract<TaskRunEvent, { type: "tool-result" }> =>
        event.type === "tool-result",
    );

    expect(toolResultEvents).toEqual([
      {
        type: "tool-result",
        session: events[0]!.session,
        result: { name: "run_subagents", output: keptOutput },
      },
    ]);
    expect(outcome.kind).toBe("success");
  });

  test("returns generation-error on a generate throw, skips commit, and disposes resources", async () => {
    const failure = new Error("generation failed");
    const sandbox = makeSandbox();
    const session = makeSession();

    const { events, outcome } = await executeRun(
      "broken task",
      makeDependencies({
        sandbox,
        session,
        agent: makeAgent(async () => {
          throw failure;
        }),
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["session-created"]);
    expect(outcome).toEqual({
      kind: "generation-error",
      session: events[0]!.session,
      error: failure,
    });
    expect(session.commitCalls).toEqual([]);
    expect(session.asyncDisposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);
    expect(sandbox.asyncDisposeCalls).toBe(1);
    expect(sandbox.disposeCalls).toBe(0);
  });

  test("returns aborted for a pre-aborted signal and skips commit", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = makeSession();

    const { events, outcome } = await executeRun(
      "aborted before start",
      makeDependencies({
        session,
        agent: makeAgent(async (_task, options) => {
          if (options?.abortSignal?.aborted) {
            throw makeAbortError("already aborted");
          }

          return makeRunResult("unexpected");
        }),
      }),
      controller.signal,
    );

    expect(events.map((event) => event.type)).toEqual(["session-created"]);
    expect(outcome).toEqual({
      kind: "aborted",
      session: events[0]!.session,
      error: expect.objectContaining({ name: "AbortError", message: "already aborted" }),
    });
    expect(session.commitCalls).toEqual([]);
  });

  test("returns aborted for an AbortError raised during generation and skips commit", async () => {
    const controller = new AbortController();
    const session = makeSession();

    const { events, outcome } = await executeRun(
      "abort while generating",
      makeDependencies({
        session,
        agent: makeAgent(async () => {
          controller.abort();
          throw makeAbortError("during generation");
        }),
      }),
      controller.signal,
    );

    expect(events.map((event) => event.type)).toEqual(["session-created"]);
    expect(outcome).toEqual({
      kind: "aborted",
      session: events[0]!.session,
      error: expect.objectContaining({
        name: "AbortError",
        message: "during generation",
      }),
    });
    expect(session.commitCalls).toEqual([]);
  });

  test("returns commit-error after the result event when commitAll throws", async () => {
    const result = makeRunResult("done");
    const commitError = new Error("commit failed");

    const { events, outcome } = await executeRun(
      "commit failure",
      makeDependencies({
        session: makeSession({ commitError }),
        agent: makeAgent(async () => result),
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["session-created", "result"]);
    expect(outcome).toEqual({
      kind: "commit-error",
      session: events[0]!.session,
      result,
      error: commitError,
    });
  });

  test("maps session and agent creation failures to the actual generation-error API without fake recovery details", async () => {
    const sessionError = new Error("session setup failed");
    const agentError = new Error("agent setup failed");
    const sandboxForSessionError = makeSandbox();
    const sandboxForAgentError = makeSandbox();
    const sessionForAgentError = makeSession();

    const sessionSetup = await executeRun(
      "session setup",
      makeDependencies({
        sandbox: sandboxForSessionError,
        createSessionError: sessionError,
      }),
    );
    const agentSetup = await executeRun(
      "agent setup",
      makeDependencies({
        sandbox: sandboxForAgentError,
        session: sessionForAgentError,
        createAgentError: agentError,
      }),
    );

    expect(sessionSetup.events).toEqual([]);
    expect(sessionSetup.outcome).toEqual({
      kind: "generation-error",
      session: undefined,
      error: sessionError,
    });
    expect(sandboxForSessionError.asyncDisposeCalls).toBe(1);
    expect(agentSetup.events.map((event) => event.type)).toEqual(["session-created"]);
    expect(agentSetup.outcome).toEqual({
      kind: "generation-error",
      session: agentSetup.events[0]!.session,
      error: agentError,
    });
    expect(sessionForAgentError.commitCalls).toEqual([]);
    expect(sessionForAgentError.asyncDisposeCalls).toBe(1);
    expect(sandboxForAgentError.asyncDisposeCalls).toBe(1);
  });

  test("disposes each resource once and preserves the primary error if disposal also fails", async () => {
    const primaryError = new Error("primary generate failure");
    const disposalError = new Error("dispose failure");
    const sandbox = makeSandbox({ asyncDisposeError: disposalError });
    const session = makeSession();

    const { outcome } = await executeRun(
      "dispose mismatch",
      makeDependencies({
        sandbox,
        session,
        agent: makeAgent(async () => {
          throw primaryError;
        }),
      }),
    );

    expect(session.asyncDisposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);
    expect(sandbox.asyncDisposeCalls).toBe(1);
    expect(sandbox.disposeCalls).toBe(0);
    expect(outcome).toEqual({
      kind: "generation-error",
      session: {
        id: "session-1",
        branch: "agent/session-1",
        base: "origin/main",
        path: "/tmp/session-1",
      },
      error: primaryError,
    });
  });

  test("prepares an injected launch project once and uses its root for parent and child sessions", async () => {
    const projectSource = {
      projectRoot: "/canonical/project",
      commonGitDir: "/canonical/project/.git",
    };
    const sandbox = makeSandbox();
    const parentSession = makeSession();
    const childSession = makeSession() as unknown as ChildSession;
    const resolvedProjectDirs: string[] = [];
    const sandboxOptions: unknown[] = [];
    const parentSessionConfigs: Array<{ repoDir?: string }> = [];
    const childSessionConfigs: Array<{ repoDir?: string }> = [];
    let agentFactoryCalls = 0;
    let modelCalls = 0;

    const dependencies = await createProductionTaskRunDependencies(undefined, {
      projectDir: "/launch/project",
      env: { AZURE_API_KEY: "test-api-key" },
      resolveProjectSource: async (projectDir) => {
        resolvedProjectDirs.push(projectDir);
        return projectSource;
      },
      createSandbox: async (options) => {
        sandboxOptions.push(options);
        return sandbox;
      },
      createSession: async (_sandbox, config) => {
        parentSessionConfigs.push(config);
        return parentSession;
      },
      createChildSession: async (_sandbox, config, _options) => {
        childSessionConfigs.push(config);
        return childSession;
      },
      createAgent: async (_sandbox, _config, options) => {
        agentFactoryCalls += 1;
        await options.delegation!.createChildSession({
          id: "delegated task",
          parentRef: parentSession.branch,
          task: {} as never,
        });
        return makeAgent(async () => {
          modelCalls += 1;
          return makeRunResult("done");
        });
      },
    });

    const { outcome } = await executeRun("project task", dependencies);

    expect(outcome.kind).toBe("success");
    expect(resolvedProjectDirs).toEqual(["/launch/project"]);
    expect(sandboxOptions).toEqual([expect.objectContaining({ projectSource })]);
    expect(parentSessionConfigs).toEqual([
      expect.objectContaining({ repoDir: projectSource.projectRoot }),
    ]);
    expect(childSessionConfigs).toEqual([
      expect.objectContaining({ repoDir: projectSource.projectRoot }),
    ]);
    expect(agentFactoryCalls).toBe(1);
    expect(modelCalls).toBe(1);
  });

  test("keeps the default no-project factory behavior", async () => {
    const sandbox = makeSandbox();
    const session = makeSession();
    const sandboxOptions: unknown[] = [];
    let resolverCalls = 0;

    const dependencies = await createProductionTaskRunDependencies(undefined, {
      env: { AZURE_API_KEY: "test-api-key" },
      resolveProjectSource: async () => {
        resolverCalls += 1;
        throw new Error("resolver should not run without a project directory");
      },
      createSandbox: async (options) => {
        sandboxOptions.push(options);
        return sandbox;
      },
      createSession: async () => session,
      createAgent: async () => makeAgent(async () => makeRunResult("done")),
    });

    const { outcome } = await executeRun("guest-only task", dependencies);

    expect(outcome.kind).toBe("success");
    expect(resolverCalls).toBe(0);
    expect(sandboxOptions).toEqual([
      expect.not.objectContaining({ projectSource: expect.anything() }),
    ]);
  });

  test("maps launch-project preparation failures before sandbox, session, agent, or model work", async () => {
    const fixtureProjectPath = "/private/project/path";
    const preflightFailure = new Error(`fixture project backend failure ${fixtureProjectPath}`);
    let sandboxCalls = 0;
    let sessionCalls = 0;
    let agentCalls = 0;
    let modelCalls = 0;

    const dependencies = await createProductionTaskRunDependencies(undefined, {
      projectDir: "/not-a-project",
      resolveProjectSource: async () => {
        throw preflightFailure;
      },
      createSandbox: async () => {
        sandboxCalls += 1;
        return makeSandbox();
      },
      createSession: async () => {
        sessionCalls += 1;
        return makeSession();
      },
      createAgent: async () => {
        agentCalls += 1;
        return makeAgent(async () => {
          modelCalls += 1;
          return makeRunResult("unexpected");
        });
      },
    });

    const { events, outcome } = await executeRun("invalid project", dependencies);
    const serialized = JSON.stringify({ events, outcome });

    expect(events).toEqual([]);
    expect(outcome).toEqual({
      kind: "generation-error",
      session: undefined,
      error: expect.objectContaining({ message: "Unable to prepare the launch project." }),
    });
    expect(sandboxCalls).toBe(0);
    expect(sessionCalls).toBe(0);
    expect(agentCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(serialized).not.toContain(preflightFailure.message);
    expect(serialized).not.toContain(fixtureProjectPath);
  });
});

describe("createProductionTaskRunDependencies", () => {
  const fixtureKey = "fixture-azure-api-key";
  const fixtureSource = "fixture-secret-store";
  const backendErrorText = "fixture secret backend unavailable";

  function makeConfig(): NonNullable<ProductionTaskRunDependencyOverrides["config"]> {
    return {
      agent: {
        rules: "fixture rules",
        llm: {
          providers: {
            azure: { apiKey: "config-api-key" },
          },
        },
      },
      sandbox: {},
      session: {},
    } as NonNullable<ProductionTaskRunDependencyOverrides["config"]>;
  }

  function makeSecretStore(get: SecretStore["get"]): SecretStore {
    return {
      get,
      async set() {},
      async delete() {
        return false;
      },
    };
  }

  test("uses Foundry env, Azure env, then the secure store without mutating config or env", async () => {
    const cases = [
      {
        env: {
          AZURE_FOUNDRY_API_KEY: "foundry-env-key",
          AZURE_API_KEY: "azure-env-key",
        },
        expectedKey: "foundry-env-key",
      },
      {
        env: { AZURE_API_KEY: "azure-env-key" },
        expectedKey: "azure-env-key",
      },
      { env: {}, expectedKey: fixtureKey },
    ];

    for (const { env, expectedKey } of cases) {
      const config = makeConfig();
      const envSnapshot = { ...env };
      let receivedConfig: unknown;
      const dependencies = await createProductionTaskRunDependencies("fixture-config", {
        config,
        env,
        secretStore: makeSecretStore(async () => fixtureKey),
        createSandbox: async () => makeSandbox(),
        createSession: async () => makeSession({ commitResult: null }),
        createAgent: async (_sandbox, agentConfig) => {
          receivedConfig = agentConfig;
          return makeAgent(async () => makeRunResult("done"));
        },
      });

      const { events, outcome } = await executeRun("fixture task", dependencies);
      const serialized = JSON.stringify({ events, outcome });

      expect(receivedConfig).toMatchObject({
        llm: { providers: { azure: { apiKey: expectedKey } } },
      });
      expect(receivedConfig).not.toMatchObject({
        llm: { providers: { azure: { apiKey: "config-api-key" } } },
      });
      expect(
        (receivedConfig as { llm: { providers: { azure: unknown } } }).llm.providers.azure,
      ).toEqual({ apiKey: expectedKey });
      expect(config.agent.llm.providers?.azure?.apiKey).toBe("config-api-key");
      expect(env).toEqual(envSnapshot);
      expect(serialized).not.toContain(fixtureKey);
      expect(serialized).not.toContain(fixtureSource);
      expect(serialized).not.toContain(backendErrorText);
    }
  });

  test("returns a redacted credential error before any lifecycle factory runs when the secure store has no key", async () => {
    let sandboxCreates = 0;
    let sessionCreates = 0;
    let agentCreates = 0;
    let agentCreateHooks = 0;
    const dependencies = await createProductionTaskRunDependencies("fixture-config", {
      config: makeConfig(),
      env: {},
      secretStore: makeSecretStore(async () => undefined),
      createSandbox: async () => {
        sandboxCreates += 1;
        return makeSandbox();
      },
      createSession: async () => {
        sessionCreates += 1;
        return makeSession();
      },
      onAgentCreate() {
        agentCreateHooks += 1;
      },
      createAgent: async () => {
        agentCreates += 1;
        return makeAgent(async () => makeRunResult("unexpected"));
      },
    });

    const { events, outcome } = await executeRun("fixture task", dependencies);
    const serialized = JSON.stringify({ events, outcome });

    expect(events).toEqual([]);
    expect(outcome).toEqual({
      kind: "generation-error",
      session: undefined,
      error: expect.objectContaining({
        message: "Azure API key missing; run agentj:secrets ... or set env",
      }),
    });
    expect(sandboxCreates).toBe(0);
    expect(sessionCreates).toBe(0);
    expect(agentCreates).toBe(0);
    expect(agentCreateHooks).toBe(0);
    expect(serialized).not.toContain(fixtureKey);
    expect(serialized).not.toContain(fixtureSource);
    expect(serialized).not.toContain(backendErrorText);
  });

  test("returns a redacted credential error before any lifecycle factory runs when the store is unavailable", async () => {
    let sandboxCreates = 0;
    let sessionCreates = 0;
    let agentCreates = 0;
    let agentCreateHooks = 0;
    const dependencies = await createProductionTaskRunDependencies("fixture-config", {
      config: makeConfig(),
      env: {},
      secretStore: makeSecretStore(async () => {
        const unavailableError = new SecretStoreUnavailableError();
        unavailableError.message = backendErrorText;
        throw unavailableError;
      }),
      createSandbox: async () => {
        sandboxCreates += 1;
        return makeSandbox();
      },
      createSession: async () => {
        sessionCreates += 1;
        return makeSession();
      },
      onAgentCreate() {
        agentCreateHooks += 1;
      },
      createAgent: async () => {
        agentCreates += 1;
        return makeAgent(async () => makeRunResult("unexpected"));
      },
    });

    const { events, outcome } = await executeRun("fixture task", dependencies);
    const serialized = JSON.stringify({ events, outcome });

    expect(events).toEqual([]);
    expect(outcome).toEqual({
      kind: "generation-error",
      session: undefined,
      error: expect.objectContaining({
        message:
          "Secure secret store unavailable; set AZURE_FOUNDRY_API_KEY/AZURE_API_KEY for automation or configure the OS keychain.",
      }),
    });
    expect(sandboxCreates).toBe(0);
    expect(sessionCreates).toBe(0);
    expect(agentCreates).toBe(0);
    expect(agentCreateHooks).toBe(0);
    expect(serialized).not.toContain(fixtureKey);
    expect(serialized).not.toContain(fixtureSource);
    expect(serialized).not.toContain(backendErrorText);
  });

  test("passes only an explicit or enabled content-free metrics sink to agent creation", async () => {
    const explicitSink: MetricsSink = { record() {} };
    const enabledSink: MetricsSink = { record() {} };
    const capturedMetrics: unknown[] = [];
    const factoryOptions: unknown[] = [];

    for (const overrides of [
      { metricsSink: explicitSink, env: {} },
      {
        env: { AGENTJ_OTEL_METRICS: "1" },
        createMetricsSink(options: { enabled: boolean }) {
          factoryOptions.push(options);
          return enabledSink;
        },
      },
      {
        env: {},
        createMetricsSink(options: { enabled: boolean }) {
          factoryOptions.push(options);
          return { record() {} };
        },
      },
    ]) {
      const dependencies = await createProductionTaskRunDependencies("fixture-config", {
        config: makeConfig(),
        secretStore: makeSecretStore(async () => fixtureKey),
        createSandbox: async () => makeSandbox(),
        createSession: async () => makeSession({ commitResult: null }),
        createAgent: async (_sandbox, _config, options) => {
          capturedMetrics.push(options.metricsSink);
          return makeAgent(async () => makeRunResult("done"));
        },
        ...overrides,
      });

      await executeRun("secret prompt /private/project/path", dependencies);
    }

    expect(capturedMetrics).toEqual([explicitSink, enabledSink, expect.any(Object)]);
    expect(factoryOptions).toEqual([{ enabled: true }, { enabled: false }]);
    expect(JSON.stringify(factoryOptions)).not.toContain("secret prompt");
    expect(JSON.stringify(factoryOptions)).not.toContain("/private/project/path");
  });
});
