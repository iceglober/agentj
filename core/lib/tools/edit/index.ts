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

export const createEditTools = (mode: EditMode, sandbox: Sandbox) =>
  editModes[mode](sandbox);

export { createBatchEditTools, createExactEditTools, createHashEditTools };
