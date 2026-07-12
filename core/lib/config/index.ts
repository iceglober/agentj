import z from "zod";
import { llmConfigSchema } from "../llm";
import { microsandboxOptionsSchema } from "../sandbox/microsandbox-adapter";
import { editConfigSchema } from "../tools/edit";

/**
 * The user-facing config surface, composed from the schemas each domain
 * module exports next to its registry — this module defines no shapes of its
 * own. Every field has a default, so `{}` (or a missing file) is valid.
 */
export const configSchema = z.object({
  llm: llmConfigSchema.prefault({}),
  sandbox: microsandboxOptionsSchema.prefault({}),
  tools: z
    .object({
      edit: editConfigSchema.prefault({}),
    })
    .prefault({}),
});

export type AgentConfig = z.infer<typeof configSchema>;

/**
 * Load config from a JSON file, validated and filled with defaults.
 * A missing file yields the full default config; a malformed or invalid
 * file throws.
 */
export async function loadConfig(path?: string): Promise<AgentConfig> {
  let raw: unknown = {};
  if (path) {
    const file = Bun.file(path);
    if (await file.exists()) raw = await file.json();
  }
  return configSchema.parse(raw);
}
