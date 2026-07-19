import type z from "zod";
import { listConfigPaths } from "../config-cli";
import { configSchema } from "./index";
import { CONFIG_DOCS } from "./reference";

const DESCRIPTIONS = new Map(CONFIG_DOCS.map((doc) => [doc.path, doc.description]));

export type ConfigFieldKind = "enum" | "boolean" | "number" | "string" | "string-array" | "record";

export interface ConfigField {
  path: string;
  kind: ConfigFieldKind;
  description?: string;
  defaultValue: unknown;
  enumValues?: string[];
  secret?: boolean;
}

type InternalSchema = z.ZodType & {
  unwrap?: () => InternalSchema;
  _zod?: {
    def?: {
      type?: string;
      innerType?: InternalSchema;
      shape?: Record<string, InternalSchema>;
      element?: InternalSchema;
      valueType?: InternalSchema;
      entries?: Record<string, string>;
    };
  };
};

const unwrap = (schema: InternalSchema): InternalSchema => {
  let current = schema;
  while (true) {
    const type = current._zod?.def?.type;
    if (!type || !["default", "prefault", "optional"].includes(type)) return current;
    const inner = current.unwrap?.() ?? current._zod?.def?.innerType;
    if (!inner) return current;
    current = inner;
  }
};

const schemaAtPath = (path: readonly string[]): InternalSchema | null => {
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
    return null;
  }
  return unwrap(current);
};

const valueAtPath = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const kindFor = (schema: InternalSchema): ConfigFieldKind => {
  const def = schema._zod?.def;
  if (def?.type === "enum") return "enum";
  if (def?.type === "boolean") return "boolean";
  if (def?.type === "number") return "number";
  if (def?.type === "record") return "record";
  if (def?.type === "array" && def.element && unwrap(def.element)._zod?.def?.type === "string") {
    return "string-array";
  }
  return "string";
};

export function configField(path: string): ConfigField {
  if (!listConfigPaths().includes(path)) {
    throw new Error(`Unknown configuration path: ${path}`);
  }
  const segments = path.split(".");
  const schema = schemaAtPath(segments);
  if (!schema) throw new Error(`Unknown configuration path: ${path}`);
  const def = schema._zod?.def;
  const enumValues = def?.type === "enum" ? Object.values(def.entries ?? {}) : undefined;
  const description = DESCRIPTIONS.get(path);
  return {
    path,
    kind: kindFor(schema),
    defaultValue: valueAtPath(configSchema.parse({}), segments),
    ...(description ? { description } : {}),
    ...(enumValues ? { enumValues } : {}),
    ...(path.endsWith("apiKey") || /(^|\.)providers\..*\.api_key$/u.test(path)
      ? { secret: true }
      : {}),
  };
}
