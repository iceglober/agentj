import z from "zod";
import { llmProviders, type ProviderName } from "../llm";
import { editModes, type EditMode } from "../tools/edit";

const providerNames = Object.keys(llmProviders) as [
  ProviderName,
  ...ProviderName[],
];
const editModeNames = Object.keys(editModes) as [EditMode, ...EditMode[]];

/**
 * The user-facing config surface. Keys mirror the lib structure:
 * llm.{provider,model,temperature}, llm.providers.{name}.*,
 * sandbox.{image,workdir}, tools.edit.mode. Every field has a default, so
 * `{}` (or a missing file) is a valid config.
 */
export const configSchema = z.object({
  llm: z
    .object({
      provider: z.enum(providerNames).default("azure"),
      model: z.string().default("gpt-5.6-sol"),
      temperature: z.number().min(0).max(2).optional(),
      providers: z
        .object({
          azure: z
            .object({
              resourceName: z.string().optional(),
              apiKey: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .prefault({}),
  sandbox: z
    .object({
      image: z.string().default("python"),
      workdir: z.string().default("/workspace"),
    })
    .prefault({}),
  tools: z
    .object({
      edit: z
        .object({
          mode: z.enum(editModeNames).default("batch"),
        })
        .prefault({}),
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
