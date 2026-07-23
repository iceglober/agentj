import type z from "zod";
import { parseRulePattern } from "./agent/permissions";
import {
  type ConfigObject,
  configSchema,
  type GlobalConfigMutation,
  type GlobalConfigOptions,
  mergeConfig,
  mutateGlobalConfig,
  readGlobalConfig,
  type ValidatedConfigPath,
} from "./config";
import { providerNames } from "./llm";
import { AZURE_API_KEY_ACCOUNT, AZURE_SECRET_SERVICE, type SecretStore } from "./secrets";

/** Compound public keys that update a provider/model pair atomically. */
export const LLM_MODEL_KEY = "llm.model";
export const SUBAGENT_LLM_MODEL_KEY = "subagents.model";
/** Legacy public secret alias retained for existing scripts. */
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
  readConfig?: (options?: GlobalConfigOptions) => Promise<ConfigObject>;
  secretStore: SecretStore;
  prompt: MaskedSecretPrompt;
  writers: ConfigCliWriters;
}

export interface ConfigSetInput {
  key: string;
  value?: string;
  secret?: boolean;
}

export interface ConfigKeyValueInput {
  key: string;
  value?: string;
}

export interface ConfigDeleteInput {
  key: string;
  secret?: boolean;
}

export interface ConfigRuleInput {
  pattern: string;
  decision: "allow" | "ask" | "deny";
}

export interface ConfigUnruleInput {
  pattern: string;
}

export interface ConfigUncagedInput {
  on: boolean;
}

export type ConfigCliErrorCode =
  | "unknown_key"
  | "secret_flag_required"
  | "secret_flag_not_allowed"
  | "secret_read_not_allowed"
  | "missing_value"
  | "invalid_model"
  | "invalid_value"
  | "operation_not_supported"
  | "invalid_pattern"
  | "prompt_cancelled"
  | "config_write_failed"
  | "config_read_failed"
  | "secret_store_failed";

export type ConfigCliResult =
  | {
      ok: true;
      key: string;
      storage: "global_config" | "keychain";
      changed?: boolean;
      value?: unknown;
    }
  | {
      ok: false;
      code: ConfigCliErrorCode;
      key?: string;
    };

export interface ConfigCliHandlers {
  get(input: ConfigKeyValueInput): Promise<ConfigCliResult>;
  set(input: ConfigSetInput): Promise<ConfigCliResult>;
  /** Persist a secret collected by another masked UI. */
  setSecret(input: ConfigKeyValueInput): Promise<ConfigCliResult>;
  add(input: ConfigKeyValueInput): Promise<ConfigCliResult>;
  remove(input: ConfigKeyValueInput): Promise<ConfigCliResult>;
  delete(input: ConfigDeleteInput): Promise<ConfigCliResult>;
  /** Idempotently set a permission rule (`config allow|ask|deny <pattern>`). */
  rule(input: ConfigRuleInput): Promise<ConfigCliResult>;
  /** Remove a permission rule (`config unrule <pattern>`). */
  unrule(input: ConfigUnruleInput): Promise<ConfigCliResult>;
  /** Toggle the uncaged escape hatch (`config uncaged on|off`). */
  uncaged(input: ConfigUncagedInput): Promise<ConfigCliResult>;
}

type InternalSchema = z.ZodType & {
  _zod?: {
    def?: {
      type?: string;
      innerType?: InternalSchema;
      shape?: Record<string, InternalSchema>;
      element?: InternalSchema;
      valueType?: InternalSchema;
      options?: InternalSchema[];
    };
  };
};

const PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SECRET_PATH = ["agent", "llm", "providers", "azure", "apiKey"] as const;

const errorCopy: Record<ConfigCliErrorCode, string> = {
  unknown_key: "Unknown configuration key.\n",
  secret_flag_required: "This configuration key requires --secret.\n",
  secret_flag_not_allowed: "--secret is only valid for secret configuration keys.\n",
  secret_read_not_allowed: "Secret configuration values cannot be read.\n",
  missing_value: "A configuration value is required.\n",
  invalid_model: "llm.model must use provider/model format.\n",
  invalid_value: "Configuration value does not match the key's schema.\n",
  operation_not_supported: "This operation is not supported for the configuration key.\n",
  invalid_pattern:
    "Not a recognized tool-call pattern. Use bash(git *), edit, web, or mcp_<server>_<tool>.\n",
  prompt_cancelled: "Secret entry cancelled.\n",
  config_write_failed: "Unable to update global configuration.\n",
  config_read_failed: "Unable to read global configuration.\n",
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

const unwrap = (schema: InternalSchema): InternalSchema => {
  let current = schema;
  while (true) {
    const type = current._zod?.def?.type;
    if (!type || !["default", "prefault", "optional", "nullable"].includes(type)) return current;
    const inner = current._zod?.def?.innerType;
    if (!inner) return current;
    current = inner;
  }
};

const parsePath = (key: string): ValidatedConfigPath | null => {
  const path = key.split(".");
  return path.length > 0 && path.every((segment) => PATH_SEGMENT.test(segment))
    ? (path as unknown as ValidatedConfigPath)
    : null;
};

/** Resolve an object/record path against the composed schema without accepting unknown object keys. */
const schemaAtPath = (path: ValidatedConfigPath): InternalSchema | null => {
  let current: InternalSchema = configSchema;
  for (const segment of path) {
    const def = unwrap(current)._zod?.def;
    if (def?.type === "object") {
      const next = def.shape?.[segment];
      if (!next) return null;
      current = next;
      continue;
    }
    if (def?.type === "record" && def.valueType) {
      current = def.valueType;
      continue;
    }
    if (def?.type === "union" && def.options) {
      const next = def.options
        .map((option) => unwrap(option)._zod?.def?.shape?.[segment])
        .find((option): option is InternalSchema => option !== undefined);
      if (!next) return null;
      current = next;
      continue;
    }
    return null;
  }
  return unwrap(current);
};

/** Enumerate schema-backed configuration paths for deterministic TUI completion. */
export const listConfigPaths = (): string[] => {
  const paths = new Set<string>();
  const visit = (schema: InternalSchema, path: string[]): void => {
    const def = unwrap(schema)._zod?.def;
    if (def?.type === "object" && def.shape) {
      for (const [segment, child] of Object.entries(def.shape)) visit(child, [...path, segment]);
      return;
    }
    if (def?.type === "union" && def.options) {
      for (const option of def.options) visit(option, path);
      return;
    }
    if (path.length > 0) paths.add(path.join("."));
  };
  visit(configSchema, []);
  return [...paths].sort();
};

const isSecretPath = (path: readonly string[]): boolean =>
  path.length === SECRET_PATH.length &&
  path.every((segment, index) => segment === SECRET_PATH[index]);

const parseCliValue = (
  schema: InternalSchema,
  value: string,
): { success: true; data: unknown } | { success: false; error: z.ZodError } => {
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {}
  return schema.safeParse(parsed);
};

const getAtPath = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const modelPaths = {
  [LLM_MODEL_KEY]: {
    provider: ["agent", "llm", "provider"],
    model: ["agent", "llm", "model"],
  },
  [SUBAGENT_LLM_MODEL_KEY]: {
    provider: ["agent", "tools", "subagents", "provider"],
    model: ["agent", "tools", "subagents", "model"],
  },
} as const satisfies Record<string, { provider: ValidatedConfigPath; model: ValidatedConfigPath }>;

type ModelConfigKey = keyof typeof modelPaths;

const isModelConfigKey = (key: string): key is ModelConfigKey => Object.hasOwn(modelPaths, key);

const modelMutations = (key: ModelConfigKey, value: string): readonly GlobalConfigMutation[] => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1) return [];
  const provider = value.slice(0, slash);
  if (!(providerNames as readonly string[]).includes(provider)) return [];
  return [
    { type: "set", path: modelPaths[key].provider, value: provider },
    { type: "set", path: modelPaths[key].model, value: value.slice(slash + 1) },
  ];
};

const modelDeleteMutations = (key: ModelConfigKey): readonly GlobalConfigMutation[] => [
  { type: "delete", path: modelPaths[key].provider },
  { type: "delete", path: modelPaths[key].model },
];

/** Build config operations without depending on command parsing, filesystem, or keyring adapters. */
export function createConfigCliHandlers(dependencies: ConfigCliDependencies): ConfigCliHandlers {
  const mutateConfig = dependencies.mutateConfig ?? mutateGlobalConfig;
  const readConfig = dependencies.readConfig ?? readGlobalConfig;

  const resolveNormalPath = (
    key: string,
  ): { path: ValidatedConfigPath; schema: InternalSchema } | null => {
    const path = parsePath(key);
    if (!path || isSecretPath(path)) return null;
    const schema = schemaAtPath(path);
    return schema ? { path, schema } : null;
  };

  const write = async (
    key: string,
    mutations: readonly GlobalConfigMutation[],
  ): Promise<ConfigCliResult> => {
    try {
      const changed = await mutateConfig(mutations, dependencies.config);
      dependencies.writers.stdout.write(`Saved ${key} in global configuration.\n`);
      return { ok: true, key, storage: "global_config", changed };
    } catch {
      return writeError(dependencies.writers, "config_write_failed", key);
    }
  };

  /** Like `write`, but with a caller-supplied confirmation message. */
  const commit = async (
    key: string,
    mutations: readonly GlobalConfigMutation[],
    message: string,
  ): Promise<ConfigCliResult> => {
    try {
      const changed = await mutateConfig(mutations, dependencies.config);
      dependencies.writers.stdout.write(`${message}\n`);
      return { ok: true, key, storage: "global_config", changed };
    } catch {
      return writeError(dependencies.writers, "config_write_failed", key);
    }
  };

  /** A rule record key is not a dotted path; permissions.rules.<pattern> writes
   *  the pattern literally as the record key. */
  const rulePath = (pattern: string): ValidatedConfigPath =>
    ["permissions", "rules", pattern] as unknown as ValidatedConfigPath;

  const readEffectiveConfig = async (): Promise<ConfigObject | null> => {
    try {
      return configSchema.parse(
        mergeConfig(configSchema.parse({}) as ConfigObject, await readConfig(dependencies.config)),
      ) as ConfigObject;
    } catch {
      return null;
    }
  };

  const storeSecret = async (key: string, secret: string): Promise<ConfigCliResult> => {
    if (key !== AZURE_API_KEY_KEY && !isSecretPath(parsePath(key) ?? [])) {
      return writeError(dependencies.writers, "unknown_key", key);
    }
    if (secret.trim().length === 0)
      return writeError(dependencies.writers, "prompt_cancelled", key);
    try {
      await dependencies.secretStore.set(AZURE_SECRET_SERVICE, AZURE_API_KEY_ACCOUNT, secret);
      dependencies.writers.stdout.write("Stored providers.azure.api_key in the secure keychain.\n");
      return { ok: true, key, storage: "keychain", changed: true };
    } catch {
      return writeError(dependencies.writers, "secret_store_failed", key);
    }
  };

  return {
    async get(input) {
      if (input.key === AZURE_API_KEY_KEY || isSecretPath(parsePath(input.key) ?? [])) {
        return writeError(dependencies.writers, "secret_read_not_allowed", input.key);
      }
      const resolved = resolveNormalPath(input.key);
      if (!resolved) return writeError(dependencies.writers, "unknown_key", input.key);
      const config = await readEffectiveConfig();
      if (!config) return writeError(dependencies.writers, "config_read_failed", input.key);
      const value = getAtPath(config, resolved.path);
      dependencies.writers.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return { ok: true, key: input.key, storage: "global_config", value };
    },

    async set(input) {
      if (isModelConfigKey(input.key)) {
        if (input.secret)
          return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
        if (!input.value) return writeError(dependencies.writers, "missing_value", input.key);
        const mutations = modelMutations(input.key, input.value);
        if (mutations.length === 0)
          return writeError(dependencies.writers, "invalid_model", input.key);
        return write(input.key, mutations);
      }
      if (input.key === AZURE_API_KEY_KEY || isSecretPath(parsePath(input.key) ?? [])) {
        if (!input.secret)
          return writeError(dependencies.writers, "secret_flag_required", input.key);
        if (input.value !== undefined)
          return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
        const secret = await dependencies.prompt.askSecret();
        if (secret === null || secret.trim().length === 0) {
          return writeError(dependencies.writers, "prompt_cancelled", input.key);
        }
        return storeSecret(input.key, secret);
      }
      if (input.secret)
        return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
      const resolved = resolveNormalPath(input.key);
      if (!resolved) return writeError(dependencies.writers, "unknown_key", input.key);
      if (input.value === undefined)
        return writeError(dependencies.writers, "missing_value", input.key);
      const parsed = parseCliValue(resolved.schema, input.value);
      if (!parsed.success) return writeError(dependencies.writers, "invalid_value", input.key);
      return write(input.key, [{ type: "set", path: resolved.path, value: parsed.data }]);
    },

    async setSecret(input) {
      return storeSecret(input.key, input.value ?? "");
    },

    async add(input) {
      if (input.value === undefined)
        return writeError(dependencies.writers, "missing_value", input.key);
      const resolved = resolveNormalPath(input.key);
      if (!resolved) return writeError(dependencies.writers, "unknown_key", input.key);
      const def = resolved.schema._zod?.def;
      if (def?.type !== "array" || !def.element) {
        return writeError(dependencies.writers, "operation_not_supported", input.key);
      }
      const parsed = parseCliValue(unwrap(def.element), input.value);
      if (!parsed.success) return writeError(dependencies.writers, "invalid_value", input.key);
      const config = await readEffectiveConfig();
      if (!config) return writeError(dependencies.writers, "config_read_failed", input.key);
      const current = getAtPath(config, resolved.path);
      if (!Array.isArray(current))
        return writeError(dependencies.writers, "operation_not_supported", input.key);
      if (current.some((value) => Object.is(value, parsed.data))) {
        return { ok: true, key: input.key, storage: "global_config", changed: false };
      }
      return write(input.key, [
        { type: "set", path: resolved.path, value: [...current, parsed.data] },
      ]);
    },

    async remove(input) {
      if (input.value === undefined)
        return writeError(dependencies.writers, "missing_value", input.key);
      const resolved = resolveNormalPath(input.key);
      if (!resolved) return writeError(dependencies.writers, "unknown_key", input.key);
      const def = resolved.schema._zod?.def;
      if (def?.type !== "array" || !def.element) {
        return writeError(dependencies.writers, "operation_not_supported", input.key);
      }
      const parsed = parseCliValue(unwrap(def.element), input.value);
      if (!parsed.success) return writeError(dependencies.writers, "invalid_value", input.key);
      const config = await readEffectiveConfig();
      if (!config) return writeError(dependencies.writers, "config_read_failed", input.key);
      const current = getAtPath(config, resolved.path);
      if (!Array.isArray(current))
        return writeError(dependencies.writers, "operation_not_supported", input.key);
      const next = current.filter((value) => !Object.is(value, parsed.data));
      if (next.length === current.length)
        return { ok: true, key: input.key, storage: "global_config", changed: false };
      return write(input.key, [{ type: "set", path: resolved.path, value: next }]);
    },

    async delete(input) {
      if (isModelConfigKey(input.key)) {
        if (input.secret)
          return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
        try {
          const changed = await mutateConfig(modelDeleteMutations(input.key), dependencies.config);
          dependencies.writers.stdout.write(`Deleted ${input.key} from global configuration.\n`);
          return { ok: true, key: input.key, storage: "global_config", changed };
        } catch {
          return writeError(dependencies.writers, "config_write_failed", input.key);
        }
      }
      if (input.key === AZURE_API_KEY_KEY || isSecretPath(parsePath(input.key) ?? [])) {
        try {
          const changed = await dependencies.secretStore.delete(
            AZURE_SECRET_SERVICE,
            AZURE_API_KEY_ACCOUNT,
          );
          dependencies.writers.stdout.write(
            "Deleted providers.azure.api_key from the secure keychain.\n",
          );
          return { ok: true, key: input.key, storage: "keychain", changed };
        } catch {
          return writeError(dependencies.writers, "secret_store_failed", input.key);
        }
      }
      if (input.secret)
        return writeError(dependencies.writers, "secret_flag_not_allowed", input.key);
      const resolved = resolveNormalPath(input.key);
      if (!resolved) return writeError(dependencies.writers, "unknown_key", input.key);
      try {
        const changed = await mutateConfig(
          [{ type: "delete", path: resolved.path }],
          dependencies.config,
        );
        dependencies.writers.stdout.write(`Deleted ${input.key} from global configuration.\n`);
        return { ok: true, key: input.key, storage: "global_config", changed };
      } catch {
        return writeError(dependencies.writers, "config_write_failed", input.key);
      }
    },

    async rule(input) {
      if (!parseRulePattern(input.pattern)) {
        return writeError(dependencies.writers, "invalid_pattern", input.pattern);
      }
      return commit(
        input.pattern,
        [{ type: "set", path: rulePath(input.pattern), value: input.decision }],
        `${input.decision}  ${input.pattern}`,
      );
    },

    async unrule(input) {
      return commit(
        input.pattern,
        [{ type: "delete", path: rulePath(input.pattern) }],
        `removed  ${input.pattern}`,
      );
    },

    async uncaged(input) {
      return commit(
        "permissions.uncaged",
        [
          {
            type: "set",
            path: ["permissions", "uncaged"] as unknown as ValidatedConfigPath,
            value: input.on,
          },
        ],
        input.on
          ? "uncaged: ON — every gated tool call is allowed"
          : "uncaged: off — default-deny rules apply",
      );
    },
  };
}
