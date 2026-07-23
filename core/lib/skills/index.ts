import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "zod";

/** Shipped product skills, discovered after project and global overrides. */
export const embeddedSkillsRoot = fileURLToPath(new URL("./embedded", import.meta.url));

/**
 * Agent Skills (the agentskills.io format): a skill is a directory holding a
 * SKILL.md — YAML frontmatter (`name` + `description` at minimum) followed by
 * Markdown instructions, with optional scripts/references/assets alongside.
 * This module implements the spec's progressive disclosure: startup surfaces
 * only names and descriptions (composeSkillsPromptSection), the model
 * activates a skill by reading its SKILL.md, and an explicit `/name`
 * invocation injects the full body as the turn prompt (renderSkillInvocation).
 *
 * glorious-specific behavior uses both frontmatter and the spec's `metadata`
 * escape hatch:
 *   user-invocable: false — do not register a /name command
 *   metadata.glorious-mode: plan | build — mode to switch to on /name
 *   metadata.glorious-model-invocation: disabled — omit from the prompt listing
 */

/** 1-64 chars, lowercase alphanumerics and single interior hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .max(64)
    .regex(NAME_PATTERN, "use lowercase letters, numbers, and single hyphens"),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  "allowed-tools": z.string().optional(),
  "user-invocable": z.boolean().prefault(true),
  metadata: z.record(z.string(), z.string()).prefault({}),
});

const MODE_KEY = "glorious-mode";
const MODEL_INVOCATION_KEY = "glorious-model-invocation";

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the skill's SKILL.md — the file the model reads to activate it. */
  path: string;
  /** The skill directory; relative file references in the body resolve against it. */
  dir: string;
  /** The Markdown instructions after the frontmatter. */
  body: string;
  /** Whether this skill registers a user-facing /name command. */
  userInvocable: boolean;
  metadata: Record<string, string>;
}

export interface SkillIssue {
  path: string;
  detail: string;
}

export interface SkillFileSystem {
  /** Names of subdirectories (a missing root is empty, not an error). */
  listDirectories(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

const nodeFileSystem: SkillFileSystem = {
  listDirectories: async (path) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  readFile: (path) => readFile(path, "utf8"),
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return quoted ? trimmed.slice(1, -1) : trimmed;
};

const parseTopLevelScalar = (value: string): string | boolean => {
  const trimmed = value.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  if (quoted) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
};

/**
 * The YAML subset the spec's frontmatter needs: top-level `key: value`
 * scalars plus one level of block mapping (`metadata:`). Comments and
 * unrecognized constructs are skipped rather than fatal — schema validation
 * decides what is actually wrong.
 */
const parseFrontmatterYaml = (text: string): Record<string, unknown> => {
  const data: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):(.*)$/u);
    if (!top) continue;
    const value = (top[2] ?? "").trim();
    if (value) {
      data[top[1] ?? ""] = parseTopLevelScalar(value);
      continue;
    }
    const nested: Record<string, string> = {};
    while (index + 1 < lines.length) {
      const entry = (lines[index + 1] ?? "").match(/^\s+([A-Za-z0-9_-]+):(.*)$/u);
      if (!entry) break;
      nested[entry[1] ?? ""] = unquote(entry[2] ?? "");
      index += 1;
    }
    data[top[1] ?? ""] = Object.keys(nested).length > 0 ? nested : "";
  }
  return data;
};

export type ParsedSkill = Pick<
  Skill,
  "name" | "description" | "body" | "userInvocable" | "metadata"
>;

/** Parse one SKILL.md; a failure returns the issue detail instead of a skill. */
export function parseSkillMarkdown(source: string): ParsedSkill | { detail: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/u);
  if (!match) return { detail: "SKILL.md must start with YAML frontmatter (--- fences)" };
  const parsed = skillFrontmatterSchema.safeParse(parseFrontmatterYaml(match[1] ?? ""));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? `${first.path.join(".")}: ` : "";
    return { detail: `invalid frontmatter — ${field}${first?.message ?? "invalid value"}` };
  }
  const mode = parsed.data.metadata[MODE_KEY];
  if (mode !== undefined && mode !== "plan" && mode !== "build") {
    return { detail: `invalid frontmatter — metadata.${MODE_KEY}: use plan or build` };
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    userInvocable: parsed.data["user-invocable"],
    metadata: parsed.data.metadata,
    body: (match[2] ?? "").trim(),
  };
}

export interface SkillDiscovery {
  skills: Skill[];
  issues: SkillIssue[];
}

/**
 * Scan skill roots in precedence order — the first root to define a name wins,
 * so callers pass [project, global, embedded]. Malformed entries become issues instead
 * of failures: one broken skill must not take down the session.
 */
export async function discoverSkills(options: {
  roots: readonly string[];
  fileSystem?: SkillFileSystem;
}): Promise<SkillDiscovery> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const byName = new Map<string, Skill>();
  const issues: SkillIssue[] = [];
  for (const root of options.roots) {
    for (const dirName of await fileSystem.listDirectories(root)) {
      const dir = join(root, dirName);
      const path = join(dir, "SKILL.md");
      let source: string;
      try {
        source = await fileSystem.readFile(path);
      } catch {
        issues.push({ path, detail: "missing SKILL.md" });
        continue;
      }
      const parsed = parseSkillMarkdown(source);
      if ("detail" in parsed) {
        issues.push({ path, detail: parsed.detail });
        continue;
      }
      if (parsed.name !== dirName) {
        issues.push({
          path,
          detail: `name "${parsed.name}" must match its directory "${dirName}"`,
        });
        continue;
      }
      if (!byName.has(parsed.name)) byName.set(parsed.name, { ...parsed, path, dir });
    }
  }
  return { skills: [...byName.values()], issues };
}

/** Mode the skill switches the session to when invoked as a command. */
export const skillMode = (skill: Skill): "plan" | "build" | undefined => {
  const mode = skill.metadata[MODE_KEY];
  return mode === "plan" || mode === "build" ? mode : undefined;
};

const modelInvocationDisabled = (skill: Skill): boolean =>
  skill.metadata[MODEL_INVOCATION_KEY] === "disabled";

/**
 * The turn prompt for an explicit `/name` invocation — activation in spec
 * terms, so the full body is injected. `$ARGUMENTS` placeholders take the
 * user's arguments; a body without one gets them appended.
 */
export function renderSkillInvocation(skill: Skill, args: string): string {
  const header = `Skill "${skill.name}" invoked (from ${skill.path}; relative file references resolve against ${skill.dir}). Follow these instructions:`;
  const trimmed = args.trim();
  if (skill.body.includes("$ARGUMENTS")) {
    return `${header}\n\n${skill.body.replaceAll("$ARGUMENTS", trimmed)}`;
  }
  return trimmed
    ? `${header}\n\n${skill.body}\n\nArguments: ${trimmed}`
    : `${header}\n\n${skill.body}`;
}

/**
 * Progressive-disclosure stage 1, appended to the project rules: names and
 * descriptions only, plus the path to read on activation. Empty when no skill
 * is eligible so callers can skip the section cleanly.
 */
export function composeSkillsPromptSection(skills: readonly Skill[]): string {
  const eligible = skills.filter((skill) => !modelInvocationDisabled(skill));
  if (eligible.length === 0) return "";
  return [
    "# Skills",
    "Named workflows configured for this project. When a task matches a skill's description, read its SKILL.md and follow it before improvising your own approach. The user can also invoke some skills explicitly as /<name>.",
    ...eligible.map((skill) => `- ${skill.name} — ${skill.description} (${skill.path})`),
  ].join("\n");
}
