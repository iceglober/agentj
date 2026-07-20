import z from "zod";
import type { Sandbox } from "../sandbox";

export const instructionExtensionSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
      message:
        "Instruction extension paths must be project-relative and may not escape the project.",
    }),
  modes: z
    .array(z.enum(["plan", "build"]))
    .min(1)
    .default(["plan", "build"]),
  roles: z
    .array(z.enum(["primary", "delegate"]))
    .min(1)
    .default(["primary", "delegate"]),
  required: z.boolean().default(false),
});

export const instructionsConfigSchema = z
  .object({
    extensions: z.record(z.string().min(1), instructionExtensionSchema).default({}),
  })
  .prefault({});

export type InstructionExtension = z.infer<typeof instructionExtensionSchema>;
export type InstructionsConfig = z.infer<typeof instructionsConfigSchema>;
export type InstructionMode = "plan" | "build";
export type InstructionRole = "primary" | "delegate";

export function composeInstructionLayers(layers: readonly string[]): string {
  return layers
    .map((layer) => layer.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function loadInstructionExtensions(
  sandbox: Sandbox,
  extensions: Readonly<Record<string, InstructionExtension>>,
  scope: { mode: InstructionMode; role: InstructionRole },
): Promise<string> {
  const layers: string[] = [];
  for (const [name, extension] of Object.entries(extensions)) {
    if (!extension.modes.includes(scope.mode) || !extension.roles.includes(scope.role)) continue;
    try {
      layers.push(await sandbox.readFile(extension.path));
    } catch (error) {
      if (extension.required) {
        throw new Error(
          `Required instruction extension ${name} could not be read at ${extension.path}.`,
          { cause: error },
        );
      }
    }
  }
  return composeInstructionLayers(layers);
}
