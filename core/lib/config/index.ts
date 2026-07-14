import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import z from "zod";
import { agentConfigSchema } from "../agent";
import { evalConfigSchema } from "../eval/config";
import { microsandboxOptionsSchema } from "../sandbox/microsandbox-adapter";
import { sessionConfigSchema } from "../session";

/**
 * The user-facing config surface, composed from the schemas each domain
 * module exports next to its registry — this module defines no shapes of its
 * own. The three sections are: `agent` (identity + llm/prompt/tools), the
 * `sandbox` it runs in, and the `session` (git worktree) it works on. An
 * `eval` section is added by a later change. Every field has a default, so
 * `{}` (or a missing file) is valid.
 */
export const configSchema = z.object({
  agent: agentConfigSchema.prefault({}),
  sandbox: microsandboxOptionsSchema.prefault({}),
  session: sessionConfigSchema.prefault({}),
  eval: evalConfigSchema.prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigObject = Record<string, unknown>;

/**
 * An internal path selected by the public config-key registry. These helpers
 * deliberately do not accept dotted CLI keys: callers must validate and map
 * those keys before passing a path here.
 */
export type ValidatedConfigPath = readonly [string, ...string[]];

export type GlobalConfigMutation =
  | { type: "set"; path: ValidatedConfigPath; value: unknown }
  | { type: "delete"; path: ValidatedConfigPath };

export interface ConfigFileSystem {
  readFile(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
  writeFile(path: string, contents: string, options: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const nodeFileSystem: ConfigFileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  writeFile: (path, contents, options) => writeFile(path, contents, options),
  rename,
  rm,
  chmod,
};

export interface GlobalConfigOptions {
  /** An explicit test or caller override for the normal global config file. */
  globalConfigPath?: string;
  /** Defaults to process.env.HOME; pass explicitly in tests. */
  home?: string;
  fileSystem?: ConfigFileSystem;
}

export interface ConfigLoadOptions extends GlobalConfigOptions {}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneObject(value: ConfigObject): ConfigObject {
  return JSON.parse(JSON.stringify(value)) as ConfigObject;
}

/** Merge JSON objects recursively; non-object values (including arrays) replace. */
export function mergeConfig(...sources: ConfigObject[]): ConfigObject {
  const result: ConfigObject = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const current = result[key];
      result[key] = isObject(current) && isObject(value)
        ? mergeConfig(current, value)
        : isObject(value)
          ? cloneObject(value)
          : value;
    }
  }

  return result;
}

/**
 * Resolve the normal global config location without touching the filesystem.
 * An override is useful for tests and for callers that deliberately manage a
 * different configuration root. HOME is required only when no override exists.
 */
export function resolveGlobalConfigPath(options: GlobalConfigOptions = {}): string {
  if (options.globalConfigPath) return options.globalConfigPath;

  const home = options.home ?? process.env.HOME;
  if (!home) {
    throw new Error(
      "Cannot resolve the global AgentJ config path: HOME is unavailable and no globalConfigPath override was provided.",
    );
  }

  return join(home, ".config", "agentj", "config.json");
}

async function readJsonObject(
  path: string,
  label: string,
  fileSystem: ConfigFileSystem,
): Promise<ConfigObject> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Unable to read ${label} config at ${path}: ${String(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Malformed ${label} config at ${path}: expected JSON object.`, { cause: error });
  }

  if (!isObject(parsed)) {
    throw new Error(`Malformed ${label} config at ${path}: expected a JSON object.`);
  }

  return parsed;
}

/** Read the normal global config. A missing file is equivalent to `{}`. */
export async function readGlobalConfig(options: GlobalConfigOptions = {}): Promise<ConfigObject> {
  const path = resolveGlobalConfigPath(options);
  return readJsonObject(path, "global", options.fileSystem ?? nodeFileSystem);
}

async function writeGlobalConfig(
  config: ConfigObject,
  options: GlobalConfigOptions,
): Promise<void> {
  const path = resolveGlobalConfigPath(options);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const directory = dirname(path);
  const temporaryPath = join(directory, `.config-${process.pid}-${crypto.randomUUID()}.tmp`);
  const contents = `${JSON.stringify(config, null, 2)}\n`;

  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(directory, 0o700);

  try {
    await fileSystem.writeFile(temporaryPath, contents, { mode: 0o600 });
    await fileSystem.chmod(temporaryPath, 0o600);
    await fileSystem.rename(temporaryPath, path);
    await fileSystem.chmod(path, 0o600);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(`Unable to write global config at ${path}: ${String(error)}`, { cause: error });
  }
}

function setAtPath(config: ConfigObject, path: ValidatedConfigPath, value: unknown): boolean {
  let target = config;
  for (const segment of path.slice(0, -1)) {
    const current = target[segment];
    if (!isObject(current)) target[segment] = {};
    target = target[segment] as ConfigObject;
  }

  const key = path[path.length - 1];
  if (Object.is(target[key], value)) return false;
  target[key] = value;
  return true;
}

function deleteAtPath(config: ConfigObject, path: ValidatedConfigPath): boolean {
  let target = config;
  for (const segment of path.slice(0, -1)) {
    const current = target[segment];
    if (!isObject(current)) return false;
    target = current;
  }

  const key = path[path.length - 1];
  if (!Object.hasOwn(target, key)) return false;
  delete target[key];
  return true;
}

/**
 * Apply normal config mutations to an in-memory copy, validate the resulting
 * effective config, then replace the file at most once. A read or validation
 * failure occurs before the write boundary, so the persisted config is left
 * untouched.
 */
export async function mutateGlobalConfig(
  mutations: readonly GlobalConfigMutation[],
  options: GlobalConfigOptions = {},
): Promise<boolean> {
  const config = cloneObject(await readGlobalConfig(options));
  let changed = false;

  for (const mutation of mutations) {
    changed = (mutation.type === "set"
      ? setAtPath(config, mutation.path, mutation.value)
      : deleteAtPath(config, mutation.path)) || changed;
  }

  if (!changed) return false;

  // Keep unknown fields in `config`, but validate the known effective shape
  // before crossing the write boundary.
  configSchema.parse(mergeConfig(configSchema.parse({}) as ConfigObject, config));
  await writeGlobalConfig(config, options);
  return true;
}

/** Set a normal value at a path already mapped and validated by the caller. */
export async function setGlobalConfigValue(
  path: ValidatedConfigPath,
  value: unknown,
  options: GlobalConfigOptions = {},
): Promise<boolean> {
  return mutateGlobalConfig([{ type: "set", path, value }], options);
}

/** Delete a normal value at a path already mapped and validated by the caller. */
export async function deleteGlobalConfigValue(
  path: ValidatedConfigPath,
  options: GlobalConfigOptions = {},
): Promise<boolean> {
  return mutateGlobalConfig([{ type: "delete", path }], options);
}

/**
 * Load defaults, then normal global config, then the supplied project/bundled
 * config. The supplied path keeps the original API shape and wins on conflict.
 */
export async function loadConfig(path?: string, options: ConfigLoadOptions = {}): Promise<Config> {
  const defaults = configSchema.parse({}) as ConfigObject;
  const global = await readGlobalConfig(options);
  const supplied = path
    ? await readJsonObject(path, "supplied", options.fileSystem ?? nodeFileSystem)
    : {};

  return configSchema.parse(mergeConfig(defaults, global, supplied));
}
