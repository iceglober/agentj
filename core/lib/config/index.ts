import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import z from "zod";
import { agentConfigSchema } from "../agent";
import { permissionsConfigSchema } from "../agent/permissions";
import { evalConfigSchema } from "../eval/config";
import {
  type McpConfig,
  type McpServerConfig,
  mcpConfigSchema,
  mcpServerConfigSchema,
} from "../mcp";
import { metricsConfigSchema } from "../metrics";
import { microsandboxOptionsSchema } from "../sandbox/microsandbox-adapter";
import { sessionConfigSchema } from "../session";
import { tuiConfigSchema } from "../tui/config";
import { updateConfigSchema } from "../update";
import { projectSetupConfigSchema } from "../workspace";

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
  mcp: mcpConfigSchema.prefault({}),
  permissions: permissionsConfigSchema.prefault({}),
  sandbox: microsandboxOptionsSchema.prefault({}),
  session: sessionConfigSchema.prefault({}),
  eval: evalConfigSchema.prefault({}),
  project: projectSetupConfigSchema.prefault({}),
  metrics: metricsConfigSchema.prefault({}),
  update: updateConfigSchema.prefault({}),
  tui: tuiConfigSchema.prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
/** Marks a trusted TypeScript configuration object for type checking. */
export function defineConfig<T extends ConfigInput>(config: T): T {
  return config;
}
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
  /** An explicit test or caller override for the canonical global config file. */
  globalConfigPath?: string;
  /** Defaults to process.env.HOME; pass explicitly in tests. */
  home?: string;
  fileSystem?: ConfigFileSystem;
}

export interface ConfigLoadOptions extends GlobalConfigOptions {
  /** The Git worktree root whose `.glorious` JSON layers should be loaded. */
  projectRoot?: string;
  /** Trusted bundled TypeScript config, loaded below user-controlled layers. */
  baseConfigPath?: string;
}

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
      result[key] =
        isObject(current) && isObject(value)
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
      "Cannot resolve the global Glorious config path: HOME is unavailable and no globalConfigPath override was provided.",
    );
  }

  return join(home, ".config", "glorious", "config.json");
}

/** Resolve the committed and machine-local config files for one Git worktree. */
export function resolveProjectConfigPaths(projectRoot: string): {
  configPath: string;
  localConfigPath: string;
} {
  return {
    configPath: join(projectRoot, ".glorious", "config.json"),
    localConfigPath: join(projectRoot, ".glorious", "config.local.json"),
  };
}

async function readOptionalJsonObject(
  path: string,
  label: string,
  fileSystem: ConfigFileSystem,
): Promise<ConfigObject | undefined> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Unable to read ${label} config at ${path}: ${String(error)}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Malformed ${label} config at ${path}: expected JSON object.`, {
      cause: error,
    });
  }

  if (!isObject(parsed)) {
    throw new Error(`Malformed ${label} config at ${path}: expected a JSON object.`);
  }

  return parsed;
}

async function readJsonObject(
  path: string,
  label: string,
  fileSystem: ConfigFileSystem,
): Promise<ConfigObject> {
  return (await readOptionalJsonObject(path, label, fileSystem)) ?? {};
}

async function readConfigObject(
  path: string,
  label: string,
  fileSystem: ConfigFileSystem,
): Promise<ConfigObject> {
  if (extname(path) !== ".ts") return readJsonObject(path, label, fileSystem);
  try {
    const loaded = await import(pathToFileURL(path).href);
    const value = loaded.default;
    if (!isObject(value)) throw new Error("expected a default-exported config object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Unable to load ${label} TypeScript config at ${path}: ${String(error)}`, {
      cause: error,
    });
  }
}

/** Read the canonical global config, or an empty object when absent. */
export async function readGlobalConfig(options: GlobalConfigOptions = {}): Promise<ConfigObject> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const global = await readOptionalJsonObject(
    resolveGlobalConfigPath(options),
    "global",
    fileSystem,
  );
  return global ?? {};
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
    changed =
      (mutation.type === "set"
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

/** The named configuration layers, lowest → highest precedence. */
export type ConfigLayer = "default" | "base" | "global" | "project" | "local";
/** Layers an edit can be written to. */
export const WRITABLE_LAYERS = ["global", "project", "local"] as const;
export type WritableConfigLayer = (typeof WRITABLE_LAYERS)[number];

/** Read every layer's raw object (before merge) for provenance and layered writes. */
async function readConfigLayerObjects(
  path: string | undefined,
  options: ConfigLoadOptions,
): Promise<Record<ConfigLayer, ConfigObject> & { supplied: ConfigObject }> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const projectPaths = options.projectRoot
    ? resolveProjectConfigPaths(options.projectRoot)
    : undefined;
  return {
    default: configSchema.parse({}) as ConfigObject,
    base: options.baseConfigPath
      ? await readConfigObject(options.baseConfigPath, "bundled", fileSystem)
      : {},
    global: await readGlobalConfig(options),
    project: projectPaths
      ? await readJsonObject(projectPaths.configPath, "project", fileSystem)
      : {},
    local: projectPaths
      ? await readJsonObject(projectPaths.localConfigPath, "local project", fileSystem)
      : {},
    supplied: path ? await readConfigObject(path, "supplied", fileSystem) : {},
  };
}

/**
 * Compose configuration layers in precedence order. The explicit `path` keeps
 * its public API meaning as a caller-supplied final override; chat startup uses
 * `baseConfigPath` for Glorious's bundled TypeScript defaults instead.
 */
async function readLayeredConfig(
  path: string | undefined,
  options: ConfigLoadOptions,
): Promise<ConfigObject> {
  const l = await readConfigLayerObjects(path, options);
  return mergeConfig(l.default, l.base, l.global, l.project, l.local, l.supplied);
}

/** Each layer's raw config object, for provenance display ("where is this set"). */
export async function readConfigLayers(
  options: ConfigLoadOptions = {},
): Promise<Record<ConfigLayer, ConfigObject>> {
  const l = await readConfigLayerObjects(undefined, options);
  return { default: l.default, base: l.base, global: l.global, project: l.project, local: l.local };
}

/** The file backing a writable layer, or undefined (no project root for project/local). */
export function resolveConfigLayerPath(
  layer: WritableConfigLayer,
  options: ConfigLoadOptions = {},
): string | undefined {
  if (layer === "global") return resolveGlobalConfigPath(options);
  if (!options.projectRoot) return undefined;
  const paths = resolveProjectConfigPaths(options.projectRoot);
  return layer === "project" ? paths.configPath : paths.localConfigPath;
}

/** Apply mutations to one writable layer (global / project / local). */
export async function mutateConfigLayer(
  layer: WritableConfigLayer,
  mutations: readonly GlobalConfigMutation[],
  options: ConfigLoadOptions = {},
): Promise<boolean> {
  const path = resolveConfigLayerPath(layer, options);
  if (!path) throw new Error(`Cannot resolve the "${layer}" config layer (no project root).`);
  return mutateGlobalConfig(mutations, {
    globalConfigPath: path,
    home: options.home,
    fileSystem: options.fileSystem,
  });
}

/** The value at a dotted path within a raw config object, or undefined. */
export function valueAtConfigPath(config: ConfigObject, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Load the effective configuration with defaults validated and filled. */
export async function loadConfig(path?: string, options: ConfigLoadOptions = {}): Promise<Config> {
  return configSchema.parse(await readLayeredConfig(path, options));
}

export interface McpConfigIssue {
  name: string;
  detail: string;
  resolution: string;
}

/** Load chat config without allowing one malformed MCP server to block the TUI. */
export async function loadChatConfig(
  path?: string,
  options: ConfigLoadOptions = {},
): Promise<{ config: Config; mcpIssues: McpConfigIssue[] }> {
  const merged = await readLayeredConfig(path, options);
  const rawMcp = merged.mcp;
  const mcpDefaults = mcpConfigSchema.parse({});
  const issues: McpConfigIssue[] = [];
  let maxOutputChars = mcpDefaults.maxOutputChars;
  let rawServers: ConfigObject = {};

  if (!isObject(rawMcp)) {
    issues.push({
      name: "configuration",
      detail: "mcp must be an object",
      resolution: "Run /config delete mcp or fix the supplied config file.",
    });
  } else {
    if (Object.hasOwn(rawMcp, "maxOutputChars")) {
      const parsed = mcpConfigSchema.safeParse({
        servers: {},
        maxOutputChars: rawMcp.maxOutputChars,
      });
      if (parsed.success) maxOutputChars = parsed.data.maxOutputChars;
      else {
        issues.push({
          name: "configuration",
          detail: "mcp.maxOutputChars is invalid",
          resolution: "Run /config set mcp.maxOutputChars <number>.",
        });
      }
    }
    if (rawMcp.servers === undefined) rawServers = {};
    else if (isObject(rawMcp.servers)) rawServers = rawMcp.servers;
    else {
      issues.push({
        name: "configuration",
        detail: "mcp.servers must be an object",
        resolution: "Run /config delete mcp.servers or fix the supplied config file.",
      });
    }
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(rawServers)) {
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
      issues.push({
        name,
        detail: "server name must use letters, numbers, underscores, or hyphens",
        resolution: "Rename or remove this server in the config file.",
      });
      continue;
    }
    const parsed = mcpServerConfigSchema.safeParse(server);
    if (parsed.success) servers[name] = parsed.data;
    else {
      const first = parsed.error.issues[0];
      const field = first?.path.length ? `.${first.path.join(".")}` : "";
      issues.push({
        name,
        detail: `invalid mcp.servers.${name}${field}: ${first?.message ?? "invalid value"}`,
        resolution: `Run /mcp set ${name} with a valid definition, or /mcp remove ${name}.`,
      });
    }
  }

  const config = configSchema.parse({ ...merged, mcp: {} });
  config.mcp = { servers, maxOutputChars } satisfies McpConfig;
  return { config, mcpIssues: issues };
}
