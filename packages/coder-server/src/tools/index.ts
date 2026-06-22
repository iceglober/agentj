// Tools — the agent's hands. read/write/edit (path-guarded), grep/ls, and `bash`
// (runs in the container). All confined to the worktree: reject `..`/symlink escapes
// (PLAN R9). Writes/bash are permission-gated; reads auto-allow.
import { resolve } from "node:path";
import { isInsideWorktree, type PermissionMode } from "coder-core";

export interface ToolContext {
  worktreeRoot: string;
  /** Resolve a permission decision (blocks on the client for gated tools). */
  requestPermission(tool: string, preview: string): Promise<boolean>;
}

export interface Tool<Args = Record<string, unknown>> {
  name: string;
  description: string;
  permission: PermissionMode;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
}

/** Resolve a tool path against the worktree root and enforce the path guard (R9). */
export function safeResolve(worktreeRoot: string, relPath: string): string {
  const abs = resolve(worktreeRoot, relPath);
  if (!isInsideWorktree(worktreeRoot, abs)) {
    throw new Error(`path escapes worktree: ${relPath}`);
  }
  return abs;
}

// TODO(P1): read_file, write_file, edit_file (string-replace), list_dir/glob, grep
// (ripgrep), bash (in-container, bounded timeout). Each enforces safeResolve + the
// permission gate, and noisy ones (bash/test) route output through Extractors first.
export const CORE_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "grep",
  "bash",
  "find_capability",
];
