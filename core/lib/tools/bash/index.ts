import type { ToolSet } from "../../llm";
import type { Sandbox } from "../../sandbox";
import { createBashToolAdapter } from "./bash-tool-adapter";

export interface BashToolsOptions {
  /** The session worktree the tools' commands and file IO operate in. */
  root: string;
}

/**
 * The bash-tools port surface: sandbox-backed shell + file tools as vendor-free
 * ToolDefs. There is only one implementation (the `bash-tool` package), so this
 * delegates straight to its adapter rather than carrying a registry — the port
 * exists to keep the vendor import quarantined in `*-adapter.ts`, not to pick
 * between providers. Add a registry here the day a second impl appears.
 */
export const createBashTools = (
  sb: Sandbox,
  opts: BashToolsOptions,
): Promise<ToolSet> => createBashToolAdapter(sb, opts);
