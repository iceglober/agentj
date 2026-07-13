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

/**
 * Load config from a JSON file, validated and filled with defaults.
 * A missing file yields the full default config; a malformed or invalid
 * file throws.
 */
export async function loadConfig(path?: string): Promise<Config> {
  let raw: unknown = {};
  if (path) {
    const file = Bun.file(path);
    if (await file.exists()) raw = await file.json();
  }
  return configSchema.parse(raw);
}
