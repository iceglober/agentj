import { describe, expect, test } from "bun:test";
import type { SecretStore } from "./lib/secrets";
import {
  runSecretsCli,
  type SecretCliWriters,
  type SecretPrompt,
  type SecretsCliDependencies,
} from "./secrets-cli";

const SECRET_FIXTURE = "azure-secret-fixture-never-rendered";
const BACKEND_FIXTURE = "fake-keyring-backend-never-rendered";

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

function createStore(overrides: Partial<SecretStore> = {}): {
  store: SecretStore;
  deletes: Array<[string, string]>;
  gets: Array<[string, string]>;
  sets: Array<[string, string, string]>;
} {
  const deletes: Array<[string, string]> = [];
  const gets: Array<[string, string]> = [];
  const sets: Array<[string, string, string]> = [];

  return {
    store: {
      async get(service, account) {
        gets.push([service, account]);
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
    deletes,
    gets,
    sets,
  };
}

function createDependencies(
  store: SecretStore,
  askAzureApiKey: SecretPrompt["askAzureApiKey"] = async () => SECRET_FIXTURE,
): SecretsCliDependencies {
  return {
    store,
    prompt: { askAzureApiKey },
    version: "test",
  };
}

function createWriters(): {
  stderr: ReturnType<typeof createMemoryWriter>;
  stdout: ReturnType<typeof createMemoryWriter>;
  writers: SecretCliWriters;
} {
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  return { stdout, stderr, writers: { stdout, stderr } };
}

describe("runSecretsCli", () => {
  test("sets the exact prompted value without placing it in command arguments or output", async () => {
    const fake = createStore();
    const { stdout, stderr, writers } = createWriters();
    const argv = ["set", "azure-api-key"];

    await expect(runSecretsCli(argv, createDependencies(fake.store), writers)).resolves.toBe(0);

    expect(argv).not.toContain(SECRET_FIXTURE);
    expect(fake.sets).toEqual([["agentj", "azure-api-key", SECRET_FIXTURE]]);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
  });

  test("does not set a secret when the prompt is cancelled, empty, or whitespace-only", async () => {
    for (const response of [null, "", "   ", "\t\n"]) {
      const fake = createStore();
      const { writers } = createWriters();

      await expect(
        runSecretsCli(
          ["set", "azure-api-key"],
          createDependencies(fake.store, async () => response),
          writers,
        ),
      ).resolves.toBe(1);
      expect(fake.sets).toEqual([]);
    }
  });

  test("reports only whether an Azure key is stored", async () => {
    for (const value of [SECRET_FIXTURE, undefined]) {
      const fake = createStore({ get: async () => value });
      const { stdout, stderr, writers } = createWriters();

      await expect(
        runSecretsCli(["status"], createDependencies(fake.store), writers),
      ).resolves.toBe(0);

      expect(stdout.text()).toBe(
        value === undefined ? "Azure API key: not stored\n" : "Azure API key: stored\n",
      );
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
    }
  });

  test("reports delete results without exposing a stored value", async () => {
    for (const deleted of [true, false]) {
      const fake = createStore({ delete: async () => deleted });
      const { stdout, stderr, writers } = createWriters();

      await expect(
        runSecretsCli(["delete", "azure-api-key"], createDependencies(fake.store), writers),
      ).resolves.toBe(0);

      expect(stdout.text()).toBe(
        deleted ? "Azure API key deleted.\n" : "Azure API key was not stored.\n",
      );
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
    }
  });

  test("rejects unsupported secret accounts without prompting or touching the store", async () => {
    const fake = createStore();
    let promptCalls = 0;
    const { stderr, writers } = createWriters();

    await expect(
      runSecretsCli(
        ["set", "unsupported-account"],
        createDependencies(fake.store, async () => {
          promptCalls += 1;
          return SECRET_FIXTURE;
        }),
        writers,
      ),
    ).resolves.toBe(1);

    expect(stderr.text()).toBe(
      "agentj:secrets is deprecated; use agentj config ...\nOnly azure-api-key is supported.\n",
    );
    expect(promptCalls).toBe(0);
    expect(fake.sets).toEqual([]);
  });

  test("redacts generic unavailable-store backend errors and secret values", async () => {
    const fake = createStore({
      get: async () => {
        throw new Error(`${BACKEND_FIXTURE}: ${SECRET_FIXTURE}`);
      },
    });
    const { stdout, stderr, writers } = createWriters();

    await expect(runSecretsCli(["status"], createDependencies(fake.store), writers)).resolves.toBe(
      1,
    );

    expect(stderr.text()).toBe(
      "agentj:secrets is deprecated; use agentj config ...\nUnable to manage AgentJ secrets.\n",
    );
    expect(`${stdout.text()}${stderr.text()}`).not.toContain(BACKEND_FIXTURE);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain(SECRET_FIXTURE);
  });

  test("renders help without prompting or accessing the store", async () => {
    const fake = createStore({
      get: async () => {
        throw new Error("store must not be called");
      },
    });
    let promptCalls = 0;
    const { stdout, stderr, writers } = createWriters();

    await expect(
      runSecretsCli(
        ["--help"],
        createDependencies(fake.store, async () => {
          promptCalls += 1;
          return SECRET_FIXTURE;
        }),
        writers,
      ),
    ).resolves.toBe(0);

    expect(promptCalls).toBe(0);
    expect(fake.gets).toEqual([]);
    expect(fake.sets).toEqual([]);
    expect(fake.deletes).toEqual([]);
    expect(stdout.text()).toContain("Manage AgentJ secrets in the OS keychain.");
    expect(stdout.text()).not.toContain(SECRET_FIXTURE);
    expect(stderr.text()).toBe("");
  });
});
