import z from "zod";
import type { Sandbox } from "../../sandbox";
import { createBatchEditTools } from "./batch-edit";
import { createExactEditTools } from "./exact-edit";
import { createHashEditTools } from "./hash-edit";

/** Every edit mode yields the same toolkit shape; the tool input schemas
 * differ per mode, which is exactly what the LLM-facing surface swaps. */
export type EditToolkit = ReturnType<typeof createExactEditTools>;
export type EditToolkitFactory = (sandbox: Sandbox) => EditToolkit;

/** Registry keyed by config value (`tools.edit.mode`). */
export const editModes = {
  exact: createExactEditTools,
  batch: createBatchEditTools,
  hash: createHashEditTools,
} satisfies Record<string, (sandbox: Sandbox) => unknown>;

export type EditMode = keyof typeof editModes;

const editModeNames = Object.keys(editModes) as [EditMode, ...EditMode[]];

/** The `tools.edit.*` section of the agent config. */
export const editConfigSchema = z.object({
  mode: z.enum(editModeNames).default("batch"),
});

export type EditConfig = z.infer<typeof editConfigSchema>;

export const createEditTools = (sandbox: Sandbox, editMode: EditMode = "batch") =>
  editModes[editMode](sandbox);

export { createBatchEditTools, createExactEditTools, createHashEditTools };
