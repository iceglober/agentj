import { describe, expect, test } from "bun:test";
import type { GlobalConfigMutation } from "./config";
import {
  AZURE_API_KEY_KEY,
  type ConfigCliDependencies,
  type ConfigCliWriters,
  createConfigCliHandlers,
  LLM_MODEL_KEY,
  type MaskedSecretPrompt,
  SUBAGENT_LLM_MODEL_KEY,
} from "./config-cli";
import type { SecretStore } from "./secrets";

const SECRET_FIXTURE = "azure-secret-fixture-never-rendered";
const BACKEND_FIXTURE = "fake-keyring-backend-never-rendered";

function createMemoryWriter(): { write(text: string): void; text(): string } {
  const chunks: string[] = [];

  return {
    write(text) {
      chunks.push(text);
    },
    text() {
      return chunks.join("");
    },
  };
}

function createWriters(): {
  stdout: ReturnType<typeof createMemoryWriter>;
  stderr: ReturnType<typeof createMemoryWriter>;
  writers: ConfigCliWriters;
} {
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  return { stdout, stderr, writers: { stdout, stderr } };
}

function createConfigPort(changed = true): {
  calls: Array<readonly GlobalConfigMutation[]>;
  mutateConfig: NonNullable<ConfigCliDependencies["mutateConfig"]>;
} {
  const calls: Array<readonly GlobalConfigMutation[]> = [];
  return {
    calls,
    async mutateConfig(mutations) {
      calls.push(mutations);
      return changed;
    },
  };
}

function createStore(overrides: Partial<SecretStore> = {}): {
  deletes: Array<[string, string]>;
  sets: Array<[string, string, string]>;
  store: SecretStore;
} {
  const deletes: Array<[string, string]> = [];
  const sets: Array<[string, string, string]> = [];

  return {
    deletes,
    sets,
    store: {
      async get(service, account) {
        return overrides.get?.(service, account);
      },
      async set(service, account, secret) {
        sets.push([service, account, secret]);
        await overrides.set?.(service, account, secret);
      },
      async delete(service, account) {
        deletes.push([service, account]);
        return (await overrides.delete?.(service, account)) ?? false;
      },
    },
  };
}

function createDependencies(
  config: ReturnType<typeof createConfigPort>,
  store: SecretStore,
  askSecret: MaskedSecretPrompt["askSecret"] = async () => SECRET_FIXTURE,
  writers: ConfigCliWriters = createWriters().writers,
): ConfigCliDependencies {
  return { mutateConfig: config.mutateConfig, prompt: { askSecret }, secretStore: store, writers };
}

describe("createConfigCliHandlers", () => {
  test("sets llm.model through one two-path transaction and emits safe success copy", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const { stdout, stderr, writers } = createWriters();
    const handlers = createConfigCliHandlers(
      createDependencies(config, fake.store, undefined, writers),
    );

    await expect(handlers.set({ key: LLM_MODEL_KEY, value: "azure/gpt-5.6-sol" })).resolves.toEqual(
      {
        ok: true,
        key: LLM_MODEL_KEY,
        storage: "global_config",
        changed: true,
      },
    );

    expect(config.calls).toEqual([
      [
        { type: "set", path: ["agent", "llm", "provider"], value: "azure" },
        { type: "set", path: ["agent", "llm", "model"], value: "gpt-5.6-sol" },
      ],
    ]);
    expect(stdout.text()).toBe("Saved llm.model in global configuration.\n");
    expect(stderr.text()).toBe("");
  });

  test("sets and deletes a subagent provider/model in atomic transactions", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const handlers = createConfigCliHandlers(createDependencies(config, fake.store));

    await expect(
      handlers.set({ key: SUBAGENT_LLM_MODEL_KEY, value: "azure/gpt-5.6-luna" }),
    ).resolves.toMatchObject({ ok: true, changed: true });
    await expect(handlers.delete({ key: SUBAGENT_LLM_MODEL_KEY })).resolves.toMatchObject({
      ok: true,
      changed: true,
    });

    expect(config.calls).toEqual([
      [
        {
          type: "set",
          path: ["agent", "tools", "subagents", "provider"],
          value: "azure",
        },
        {
          type: "set",
          path: ["agent", "tools", "subagents", "model"],
          value: "gpt-5.6-luna",
        },
      ],
      [
        { type: "delete", path: ["agent", "tools", "subagents", "provider"] },
        { type: "delete", path: ["agent", "tools", "subagents", "model"] },
      ],
    ]);
  });

  test("sets a complete MCP server through a dynamic record key", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const handlers = createConfigCliHandlers(createDependencies(config, fake.store));
    const server = {
      transport: "http",
      url: "https://example.com/mcp",
      headersFromEnv: { Authorization: "MCP_TOKEN" },
      tools: { plan: ["search*"], direct: ["search_docs"] },
    };

    await expect(
      handlers.set({ key: "mcp.servers.docs", value: JSON.stringify(server) }),
    ).resolves.toMatchObject({ ok: true, changed: true });
    expect(config.calls).toMatchObject([
      [{ type: "set", path: ["mcp", "servers", "docs"], value: server }],
    ]);

    await expect(
      handlers.set({
        key: "mcp.servers.docs.headers.Authorization",
        value: '"Bearer token"',
      }),
    ).resolves.toMatchObject({ ok: true, changed: true });
    expect(config.calls.at(-1)).toEqual([
      {
        type: "set",
        path: ["mcp", "servers", "docs", "headers", "Authorization"],
        value: "Bearer token",
      },
    ]);
  });

  test("validates schema paths and mutates scalar and array values generically", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const { stdout, stderr, writers } = createWriters();
    const handlers = createConfigCliHandlers({
      ...createDependencies(config, fake.store, undefined, writers),
      readConfig: async () => ({}),
    });

    await expect(
      handlers.set({ key: "agent.llm.temperature", value: "0.7" }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    await expect(
      handlers.add({ key: "sandbox.bootstrap", value: "apt-get update" }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    await expect(handlers.set({ key: "sandbox.bootstrap", value: "[]" })).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    await expect(handlers.add({ key: "sandbox.image", value: "image" })).resolves.toMatchObject({
      ok: false,
      code: "operation_not_supported",
    });
    await expect(handlers.set({ key: "agent.unknown", value: "value" })).resolves.toMatchObject({
      ok: false,
      code: "unknown_key",
    });

    expect(config.calls).toEqual([
      [{ type: "set", path: ["agent", "llm", "temperature"], value: 0.7 }],
      [{ type: "set", path: ["sandbox", "bootstrap"], value: ["apt-get update"] }],
      [{ type: "set", path: ["sandbox", "bootstrap"], value: [] }],
    ]);
    expect(stdout.text()).toContain("Saved sandbox.bootstrap in global configuration.\n");
    expect(stderr.text()).toContain("This operation is not supported for the configuration key.\n");
  });

  test("--scope routes writes to the project and local layer files", async () => {
    const stored = new Map<string, string>();
    const fileSystem = {
      async readFile(path: string) {
        const contents = stored.get(path);
        if (contents === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return contents;
      },
      async mkdir() {},
      async writeFile(path: string, contents: string) {
        stored.set(path, contents);
      },
      async rename(from: string, to: string) {
        stored.set(to, stored.get(from)!);
        stored.delete(from);
      },
      async rm(path: string) {
        stored.delete(path);
      },
      async chmod() {},
    };
    const fake = createStore();
    const { stdout, writers } = createWriters();
    const handlers = createConfigCliHandlers({
      config: { projectRoot: "/repo", fileSystem },
      prompt: { askSecret: async () => SECRET_FIXTURE },
      secretStore: fake.store,
      writers,
    });

    await expect(
      handlers.rule({ pattern: "edit", decision: "allow", scope: "project" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handlers.set({ key: "agent.llm.temperature", value: "0.5", scope: "local" }),
    ).resolves.toMatchObject({ ok: true });

    expect(JSON.parse(stored.get("/repo/.glorious/config.json")!)).toEqual({
      permissions: { rules: { edit: "allow" } },
    });
    expect(JSON.parse(stored.get("/repo/.glorious/config.local.json")!)).toEqual({
      agent: { llm: { temperature: 0.5 } },
    });
    expect(stdout.text()).toContain("Saved agent.llm.temperature in local configuration.\n");
  });

  test("gets effective values and removes array entries without accepting secret reads", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const { stdout, stderr, writers } = createWriters();
    const handlers = createConfigCliHandlers({
      ...createDependencies(config, fake.store, undefined, writers),
      readConfig: async () => ({ sandbox: { bootstrap: ["first", "second"] } }),
    });

    await expect(handlers.get({ key: "sandbox.bootstrap" })).resolves.toMatchObject({
      ok: true,
      value: ["first", "second"],
    });
    await expect(
      handlers.remove({ key: "sandbox.bootstrap", value: "first" }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    await expect(
      handlers.remove({ key: "sandbox.bootstrap", value: "missing" }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
    });
    await expect(handlers.get({ key: AZURE_API_KEY_KEY })).resolves.toMatchObject({
      ok: false,
      code: "secret_read_not_allowed",
    });

    expect(config.calls).toEqual([
      [{ type: "set", path: ["sandbox", "bootstrap"], value: ["second"] }],
    ]);
    expect(stdout.text()).toContain('[\n  "first",\n  "second"\n]\n');
    expect(stderr.text()).toBe("Secret configuration values cannot be read.\n");
  });

  test("rejects invalid or missing llm.model values without mutating config", async () => {
    for (const value of [undefined, "azure", "/gpt-5.6-sol", "azure/", "azure/gpt/extra"]) {
      const config = createConfigPort();
      const fake = createStore();
      const { stderr, writers } = createWriters();
      const handlers = createConfigCliHandlers(
        createDependencies(config, fake.store, undefined, writers),
      );

      const result = await handlers.set({ key: LLM_MODEL_KEY, value });

      expect(result.ok).toBe(false);
      expect(config.calls).toEqual([]);
      expect(fake.sets).toEqual([]);
      expect(stderr.text()).toBe(
        value === undefined
          ? "A configuration value is required.\n"
          : "llm.model must use provider/model format.\n",
      );
    }
  });

  test("enforces secret-only and normal-only key modes without touching either store", async () => {
    const cases = [
      { input: { key: AZURE_API_KEY_KEY }, error: "This configuration key requires --secret.\n" },
      {
        input: { key: LLM_MODEL_KEY, value: "azure/gpt-5.6-sol", secret: true },
        error: "--secret is only valid for secret configuration keys.\n",
      },
    ];

    for (const { input, error } of cases) {
      const config = createConfigPort();
      const fake = createStore();
      const { stderr, writers } = createWriters();
      const handlers = createConfigCliHandlers(
        createDependencies(config, fake.store, undefined, writers),
      );

      await expect(handlers.set(input)).resolves.toMatchObject({ ok: false });
      expect(config.calls).toEqual([]);
      expect(fake.sets).toEqual([]);
      expect(stderr.text()).toBe(error);
    }
  });

  test("does not write cancelled, empty, or whitespace-only secret input", async () => {
    for (const response of [null, "", "   ", "\t\n"]) {
      const config = createConfigPort();
      const fake = createStore();
      const { stderr, writers } = createWriters();
      const handlers = createConfigCliHandlers(
        createDependencies(config, fake.store, async () => response, writers),
      );

      await expect(handlers.set({ key: AZURE_API_KEY_KEY, secret: true })).resolves.toEqual({
        ok: false,
        code: "prompt_cancelled",
        key: AZURE_API_KEY_KEY,
      });
      expect(fake.sets).toEqual([]);
      expect(stderr.text()).toBe("Secret entry cancelled.\n");
    }
  });

  test("stores the exact prompted secret without rendering or serializing it", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const { stdout, stderr, writers } = createWriters();
    const handlers = createConfigCliHandlers(
      createDependencies(config, fake.store, undefined, writers),
    );

    const result = await handlers.set({ key: AZURE_API_KEY_KEY, secret: true });

    expect(fake.sets).toEqual([["glorious", "azure-api-key", SECRET_FIXTURE]]);
    expect(JSON.stringify(result)).not.toContain(SECRET_FIXTURE);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
    expect(stdout.text()).toBe("Stored providers.azure.api_key in the secure keychain.\n");
  });

  test("stores a masked UI secret through the dedicated write", async () => {
    const config = createConfigPort();
    const fake = createStore();
    const { stdout, stderr, writers } = createWriters();
    const handlers = createConfigCliHandlers(
      createDependencies(config, fake.store, undefined, writers),
    );

    const result = await handlers.setSecret({
      key: "agent.llm.providers.azure.apiKey",
      value: SECRET_FIXTURE,
    });

    expect(result).toMatchObject({ ok: true, storage: "keychain" });
    expect(fake.sets).toEqual([["glorious", "azure-api-key", SECRET_FIXTURE]]);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
  });

  test("redacts unknown keys and unavailable secret stores", async () => {
    const unknownConfig = createConfigPort();
    const unknownStore = createStore();
    const unknownWriters = createWriters();
    const unknownHandlers = createConfigCliHandlers(
      createDependencies(unknownConfig, unknownStore.store, undefined, unknownWriters.writers),
    );

    await expect(unknownHandlers.set({ key: `unknown.${SECRET_FIXTURE}` })).resolves.toMatchObject({
      ok: false,
      code: "unknown_key",
    });
    expect(unknownConfig.calls).toEqual([]);
    expect(unknownStore.sets).toEqual([]);
    expect(`${unknownWriters.stdout.text()}${unknownWriters.stderr.text()}`).toBe(
      "Unknown configuration key.\n",
    );

    const unavailableConfig = createConfigPort();
    const unavailableStore = createStore({
      set: async () => {
        throw new Error(`${BACKEND_FIXTURE}: ${SECRET_FIXTURE}`);
      },
    });
    const unavailableWriters = createWriters();
    const unavailableHandlers = createConfigCliHandlers(
      createDependencies(
        unavailableConfig,
        unavailableStore.store,
        undefined,
        unavailableWriters.writers,
      ),
    );

    await expect(
      unavailableHandlers.set({ key: AZURE_API_KEY_KEY, secret: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "secret_store_failed",
    });
    expect(`${unavailableWriters.stdout.text()}${unavailableWriters.stderr.text()}`).toBe(
      "Secure secret store is unavailable.\n",
    );
    expect(`${unavailableWriters.stdout.text()}${unavailableWriters.stderr.text()}`).not.toContain(
      BACKEND_FIXTURE,
    );
    expect(`${unavailableWriters.stdout.text()}${unavailableWriters.stderr.text()}`).not.toContain(
      SECRET_FIXTURE,
    );
  });

  test("deletes normal configuration idempotently", async () => {
    for (const changed of [true, false]) {
      const config = createConfigPort(changed);
      const fake = createStore();
      const { stdout, stderr, writers } = createWriters();
      const handlers = createConfigCliHandlers(
        createDependencies(config, fake.store, undefined, writers),
      );

      await expect(handlers.delete({ key: LLM_MODEL_KEY })).resolves.toEqual({
        ok: true,
        key: LLM_MODEL_KEY,
        storage: "global_config",
        changed,
      });
      expect(config.calls).toEqual([
        [
          { type: "delete", path: ["agent", "llm", "provider"] },
          { type: "delete", path: ["agent", "llm", "model"] },
        ],
      ]);
      expect(stdout.text()).toBe("Deleted llm.model from global configuration.\n");
      expect(stderr.text()).toBe("");
    }
  });

  test("reports secret deletion changed semantics without exposing a stored value", async () => {
    for (const changed of [true, false]) {
      const config = createConfigPort();
      const fake = createStore({ delete: async () => changed });
      const { stdout, stderr, writers } = createWriters();
      const handlers = createConfigCliHandlers(
        createDependencies(config, fake.store, undefined, writers),
      );

      await expect(handlers.delete({ key: AZURE_API_KEY_KEY, secret: true })).resolves.toEqual({
        ok: true,
        key: AZURE_API_KEY_KEY,
        storage: "keychain",
        changed,
      });
      expect(fake.deletes).toEqual([["glorious", "azure-api-key"]]);
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
      expect(stdout.text()).toBe("Deleted providers.azure.api_key from the secure keychain.\n");
    }
  });
});

describe("permission rule verbs", () => {
  const setup = () => {
    const config = createConfigPort();
    const fake = createStore();
    const { stdout, writers } = createWriters();
    const handlers = createConfigCliHandlers({
      ...createDependencies(config, fake.store, undefined, writers),
      readConfig: async () => ({}),
    });
    return { config, stdout, handlers };
  };

  test("allow/ask/deny write the pattern as a rules record key (idempotent set)", async () => {
    const { config, handlers, stdout } = setup();
    await expect(
      handlers.rule({ pattern: "bash(pnpm *)", decision: "allow" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handlers.rule({ pattern: "mcp_linear_get_issue", decision: "ask" }),
    ).resolves.toMatchObject({ ok: true });
    expect(config.calls).toEqual([
      [{ type: "set", path: ["permissions", "rules", "bash(pnpm *)"], value: "allow" }],
      [{ type: "set", path: ["permissions", "rules", "mcp_linear_get_issue"], value: "ask" }],
    ]);
    expect(stdout.text()).toContain("allow  bash(pnpm *)");
  });

  test("rejects a pattern that is not a tool-call form", async () => {
    const { config, handlers } = setup();
    await expect(
      handlers.rule({ pattern: "not a tool", decision: "allow" }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_pattern" });
    expect(config.calls).toEqual([]);
  });

  test("unrule deletes the rule key", async () => {
    const { config, handlers } = setup();
    await expect(handlers.unrule({ pattern: "bash(rm -rf *)" })).resolves.toMatchObject({
      ok: true,
    });
    expect(config.calls).toEqual([
      [{ type: "delete", path: ["permissions", "rules", "bash(rm -rf *)"] }],
    ]);
  });

  test("uncaged toggles the boolean and reports state", async () => {
    const { config, handlers, stdout } = setup();
    await expect(handlers.uncaged({ on: true })).resolves.toMatchObject({ ok: true });
    await expect(handlers.uncaged({ on: false })).resolves.toMatchObject({ ok: true });
    expect(config.calls).toEqual([
      [{ type: "set", path: ["permissions", "uncaged"], value: true }],
      [{ type: "set", path: ["permissions", "uncaged"], value: false }],
    ]);
    expect(stdout.text()).toContain("uncaged: ON");
  });
});
