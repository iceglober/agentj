import {
  mutateGlobalConfig,
  type GlobalConfigMutation,
  type GlobalConfigOptions,
} from "./config";
import { providerNames } from "./llm/ai-sdk-adapter";
import {
  AZURE_API_KEY_ACCOUNT,
  AZURE_SECRET_SERVICE,
  type SecretStore,
} from "./secrets";

export const LLM_MODEL_KEY = "llm.model";
export const AZURE_API_KEY_KEY = "providers.azure.api_key";

export interface ConfigCliWriters {
  stdout: { write(message: string): void };
  stderr: { write(message: string): void };
}

/** This port must collect input with a masked terminal control. */
export interface MaskedSecretPrompt {
  askSecret(): Promise<string | null>;
}

export interface ConfigCliDependencies {
  config?: GlobalConfigOptions;
  mutateConfig?: (
    mutations: readonly GlobalConfigMutation[],
    options?: GlobalConfigOptions,
  ) => Promise<boolean>;
  secretStore: SecretStore;
  prompt: MaskedSecretPrompt;
  writers: ConfigCliWriters;
}

export interface ConfigSetInput {
  key: string;
  /** Normal values come from command parsing; secret values must never do so. */
  value?: string;
  secret?: boolean;
}

export interface ConfigDeleteInput {
  key: string;
  secret?: boolean;
}

export type ConfigCliErrorCode =
  | "unknown_key"
  | "secret_flag_required"
  | "secret_flag_not_allowed"
  | "missing_value"
  | "invalid_model"
  | "prompt_cancelled"
  | "config_write_failed"
  | "secret_store_failed";

export type ConfigCliResult =
  | {
      ok: true;
      key: typeof LLM_MODEL_KEY | typeof AZURE_API_KEY_KEY;
      storage: "global_config" | "keychain";
      changed: boolean;
    }
  | {
      ok: false;
      code: ConfigCliErrorCode;
      key?: string;
    };

export interface ConfigCliHandlers {
  set(input: ConfigSetInput): Promise<ConfigCliResult>;
  delete(input: ConfigDeleteInput): Promise<ConfigCliResult>;
}

const normalModelMutations = (value: string): readonly GlobalConfigMutation[] => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1) {
    return [];
  }

  const provider = value.slice(0, slash);
  if (!(providerNames as readonly string[]).includes(provider)) {
    return [];
  }

  return [
    { type: "set", path: ["agent", "llm", "provider"], value: provider },
    { type: "set", path: ["agent", "llm", "model"], value: value.slice(slash + 1) },
  ];
};

const normalModelDeleteMutations: readonly GlobalConfigMutation[] = [
  { type: "delete", path: ["agent", "llm", "provider"] },
  { type: "delete", path: ["agent", "llm", "model"] },
];

const errorCopy: Record<ConfigCliErrorCode, string> = {
  unknown_key: "Unknown configuration key.\n",
  secret_flag_required: "This configuration key requires --secret.\n",
  secret_flag_not_allowed: "--secret is only valid for secret configuration keys.\n",
  missing_value: "A configuration value is required.\n",
  invalid_model: "llm.model must use provider/model format.\n",
  prompt_cancelled: "Secret entry cancelled.\n",
  config_write_failed: "Unable to update global configuration.\n",
  secret_store_failed: "Secure secret store is unavailable.\n",
};

const writeError = (
  writers: ConfigCliWriters,
  code: ConfigCliErrorCode,
  key?: string,
): ConfigCliResult => {
  writers.stderr.write(errorCopy[code]);
  return { ok: false, code, ...(key === undefined ? {} : { key }) };
};

/**
 * Builds config operation handlers without depending on command parsing, process,
 * filesystem, or keyring adapters. Secret values enter only through `prompt`.
 */
export function createConfigCliHandlers(dependencies: ConfigCliDependencies): ConfigCliHandlers {
  const mutateConfig = dependencies.mutateConfig ?? mutateGlobalConfig;

  const updateNormalModel = async (value: string): Promise<ConfigCliResult> => {
    const mutations = normalModelMutations(value);
    if (mutations.length === 0) {
      return writeError(dependencies.writers, "invalid_model", LLM_MODEL_KEY);
    }

    try {
      const changed = await mutateConfig(mutations, dependencies.config);
      dependencies.writers.stdout.write("Saved llm.model in global configuration.\n");
      return { ok: true, key: LLM_MODEL_KEY, storage: "global_config", changed };
    } catch {
      return writeError(dependencies.writers, "config_write_failed", LLM_MODEL_KEY);
    }
  };

  return {
    async set(input): Promise<ConfigCliResult> {
      if (input.key === LLM_MODEL_KEY) {
        if (input.secret) {
          return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
        }
        if (input.value === undefined || input.value.length === 0) {
          return writeError(dependencies.writers, "missing_value", input.key);
        }
        return updateNormalModel(input.value);
      }

      if (input.key !== AZURE_API_KEY_KEY) {
        return writeError(dependencies.writers, "unknown_key", input.key);
      }
      if (!input.secret) {
        return writeError(dependencies.writers, "secret_flag_required", input.key);
      }
      if (input.value !== undefined) {
        return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
      }

      const secret = await dependencies.prompt.askSecret();
      if (secret === null || secret.trim().length === 0) {
        return writeError(dependencies.writers, "prompt_cancelled", input.key);
      }
      try {
        await dependencies.secretStore.set(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT, secret);
        dependencies.writers.stdout.write("Stored providers.azure.api_key in the secure keychain.\n");
        return { ok: true, key: AZURE_API_KEY_KEY, storage: "keychain", changed: true };
      } catch (error) {
        // Never copy keychain errors: some backends include the rejected secret.
        void error;
        return writeError(dependencies.writers, "secret_store_failed", input.key);
      }
    },

    async delete(input): Promise<ConfigCliResult> {
      if (input.key === LLM_MODEL_KEY) {
        if (input.secret) {
          return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
        }
        try {
          const changed = await mutateConfig(normalModelDeleteMutations, dependencies.config);
          dependencies.writers.stdout.write("Deleted llm.model from global configuration.\n");
          return { ok: true, key: LLM_MODEL_KEY, storage: "global_config", changed };
        } catch {
          return writeError(dependencies.writers, "config_write_failed", input.key);
        }
      }

      if (input.key !== AZURE_API_KEY_KEY) {
        return writeError(dependencies.writers, "unknown_key", input.key);
      }
      try {
        const changed = await dependencies.secretStore.delete(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT);
        dependencies.writers.stdout.write("Deleted providers.azure.api_key from the secure keychain.\n");
        return { ok: true, key: AZURE_API_KEY_KEY, storage: "keychain", changed };
      } catch (error) {
        // Same redaction boundary as secret writes.
        void error;
        return writeError(dependencies.writers, "secret_store_failed", input.key);
      }
    },
  };
}
