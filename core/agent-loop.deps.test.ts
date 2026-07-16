import { describe, expect, test } from "bun:test";
import {
  createProductionTaskRunDependencies,
  type ProductionDependencyOverrides as ProductionTaskRunDependencyOverrides,
} from "./agent-loop";
import type { Agent } from "./lib/agent";
import {
  type ConversationDependencies,
  type ConversationEvent,
  runAgentConversation,
} from "./lib/app/conversation";
import { configSchema } from "./lib/config";
import type { RunResult } from "./lib/llm";
import type { MetricsSink } from "./lib/metrics";
import type { Sandbox } from "./lib/sandbox";
import { type SecretStore, SecretStoreUnavailableError } from "./lib/secrets";
import type { Session } from "./lib/session";

type SandboxWithCalls = Sandbox & {
  asyncDisposeCalls: number;
  disposeCalls: number;
};

type SessionWithCalls = Session & {
  commitCalls: string[];
  asyncDisposeCalls: number;
  disposeCalls: number;
};

function makeRunResult(text: string): RunResult {
  return {
    text,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeSandbox(): SandboxWithCalls {
  let asyncDisposeCalls = 0;
  let disposeCalls = 0;

  const sandbox = {
    asyncDisposeCalls,
    disposeCalls,
    async [Symbol.asyncDispose]() {
      asyncDisposeCalls += 1;
      sandbox.asyncDisposeCalls = asyncDisposeCalls;
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

function makeSession(options?: { commitResult?: string | null }): SessionWithCalls {
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
    async commitAll() {
      commitCalls.push("commit");
      return hasCommitResult ? (options.commitResult ?? null) : "commit-sha-123";
    },
    async dispose() {
      disposeCalls += 1;
      this.disposeCalls = disposeCalls;
    },
    async [Symbol.asyncDispose]() {
      asyncDisposeCalls += 1;
      this.asyncDisposeCalls = asyncDisposeCalls;
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

/** Drive the production deps through the real conversation loop (no follow-up
 *  messages → planning ends as plan-ready; prepare failures surface as
 *  generation-error before any lifecycle factory runs). */
async function executeRun(task: string, dependencies: ConversationDependencies) {
  const events: ConversationEvent[] = [];
  const outcome = await runAgentConversation(task, {
    signal: new AbortController().signal,
    dependencies,
    onEvent(event) {
      events.push(event);
    },
  });

  return { events, outcome };
}

describe("createProductionTaskRunDependencies", () => {
  const fixtureKey = "fixture-azure-api-key";
  const fixtureSource = "fixture-secret-store";
  const backendErrorText = "fixture secret backend unavailable";

  function makeConfig(): NonNullable<ProductionTaskRunDependencyOverrides["config"]> {
    return configSchema.parse({
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
    });
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

  test("local mode uses the launch checkout directly without creating a worktree", async () => {
    const projectRoot = process.cwd();
    const dependencies = await createProductionTaskRunDependencies("fixture-config", {
      workspaceMode: "local",
      projectDir: projectRoot,
      config: configSchema.parse({}),
      env: { AZURE_API_KEY: fixtureKey },
      resolveProjectSource: async () => ({
        projectRoot,
        commonGitDir: `${projectRoot}/.git`,
      }),
    });
    const environment = await dependencies.createSandbox();
    const session = await dependencies.createSession(environment);
    expect(session.mode).toBe("local");
    expect(session.path).toBe(projectRoot);
    await session[Symbol.asyncDispose]();
    if (Symbol.asyncDispose in environment) {
      await (environment as unknown as AsyncDisposable)[Symbol.asyncDispose]();
    }
  });

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
        message: "Azure API key missing; run: agentj config set --secret providers.azure.api_key",
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
