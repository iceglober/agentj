import { createRequire } from "node:module";
import { stderr as processStderr, stdout as processStdout } from "node:process";

import { command, positional, runSafely, string, subcommands } from "cmd-ts";

import {
  AZURE_API_KEY_ACCOUNT,
  AZURE_SECRET_SERVICE,
  type SecretStore,
  SecretStoreUnavailableError,
} from "./lib/secrets";
import { createKeyringSecretStore } from "./lib/secrets/keyring-adapter";

type PromptQuestion = import("prompts").PromptObject<"secret">;
type PromptAnswers = import("prompts").Answers<"secret">;

export interface SecretPrompt {
  askAzureApiKey(): Promise<string | null>;
}

export interface SecretCliWriters {
  stdout: Pick<typeof processStdout, "write">;
  stderr: Pick<typeof processStderr, "write">;
}

export interface SecretsCliDependencies {
  store: SecretStore;
  prompt: SecretPrompt;
  version?: string;
}

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;

const require = createRequire(import.meta.url);
const prompts = require("prompts") as <T extends string>(
  question: PromptQuestion,
  options?: { onCancel?: () => void },
) => Promise<PromptAnswers>;

const azureAccount = ({ account }: { account: string }): number =>
  account === AZURE_API_KEY_ACCOUNT ? EXIT_SUCCESS : EXIT_FAILURE;

const writeError = (writers: SecretCliWriters, error: unknown): void => {
  if (error instanceof SecretStoreUnavailableError) {
    writers.stderr.write("Secure secret store is unavailable.\n");
    return;
  }
  writers.stderr.write("Unable to manage AgentJ secrets.\n");
};

const writeMigrationNotice = (writers: SecretCliWriters): void => {
  writers.stderr.write("agentj:secrets is deprecated; use agentj config ...\n");
};

export const createPromptsSecretPrompt = (): SecretPrompt => ({
  async askAzureApiKey(): Promise<string | null> {
    let cancelled = false;
    const answer = await prompts<"secret">(
      {
        type: "password",
        name: "secret",
        message: "Azure API key",
      },
      {
        onCancel: () => {
          cancelled = true;
        },
      },
    );
    if (cancelled || typeof answer.secret !== "string" || answer.secret.length === 0) {
      return null;
    }
    return answer.secret;
  },
});

export const createSecretsCommand = (deps: SecretsCliDependencies, writers: SecretCliWriters) => {
  const set = command({
    name: "set",
    description: "Store an AgentJ secret in the OS keychain.",
    args: {
      account: positional({ type: string }),
    },
    async handler(args): Promise<number> {
      writeMigrationNotice(writers);
      if (azureAccount(args) !== EXIT_SUCCESS) {
        writers.stderr.write("Only azure-api-key is supported.\n");
        return EXIT_FAILURE;
      }
      const secret = await deps.prompt.askAzureApiKey();
      if (secret === null || secret.trim().length === 0) {
        writers.stderr.write("No secret stored.\n");
        return EXIT_FAILURE;
      }
      try {
        await deps.store.set(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT, secret);
        writers.stdout.write("Azure API key stored in the OS keychain.\n");
        return EXIT_SUCCESS;
      } catch (error) {
        writeError(writers, error);
        return EXIT_FAILURE;
      }
    },
  });

  const status = command({
    name: "status",
    description: "Show whether the Azure API key is stored.",
    args: {},
    async handler(): Promise<number> {
      writeMigrationNotice(writers);
      try {
        const value = await deps.store.get(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT);
        writers.stdout.write(
          value === undefined ? "Azure API key: not stored\n" : "Azure API key: stored\n",
        );
        return EXIT_SUCCESS;
      } catch (error) {
        writeError(writers, error);
        return EXIT_FAILURE;
      }
    },
  });

  const remove = command({
    name: "delete",
    description: "Delete an AgentJ secret from the OS keychain.",
    args: {
      account: positional({ type: string }),
    },
    async handler(args): Promise<number> {
      writeMigrationNotice(writers);
      if (azureAccount(args) !== EXIT_SUCCESS) {
        writers.stderr.write("Only azure-api-key is supported.\n");
        return EXIT_FAILURE;
      }
      try {
        const deleted = await deps.store.delete(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT);
        writers.stdout.write(
          deleted ? "Azure API key deleted.\n" : "Azure API key was not stored.\n",
        );
        return EXIT_SUCCESS;
      } catch (error) {
        writeError(writers, error);
        return EXIT_FAILURE;
      }
    },
  });

  return subcommands({
    name: "agentj-secrets",
    version: deps.version ?? "0.0.0",
    description: "Manage AgentJ secrets in the OS keychain.",
    cmds: { set, status, delete: remove },
  });
};

export async function runSecretsCli(
  argv: string[],
  deps: SecretsCliDependencies = {
    store: createKeyringSecretStore({}),
    prompt: createPromptsSecretPrompt(),
  },
  writers: SecretCliWriters = { stdout: processStdout, stderr: processStderr },
): Promise<number> {
  const result = await runSafely(createSecretsCommand(deps, writers), argv);
  if (result._tag === "error") {
    const { exitCode, into, message } = result.error.config;
    (into === "stdout" ? writers.stdout : writers.stderr).write(message);
    return exitCode;
  }
  return await Promise.resolve(result.value.value);
}

if (import.meta.main) {
  process.exitCode = await runSecretsCli(process.argv.slice(2));
}
