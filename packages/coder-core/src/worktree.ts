// Worktree + git glue. The worktree is coder's unit of work (1:1 with a branch);
// both the chat and shell panes are pinned to it. Reimplemented clean from glrs
// prior art (`packages/cli/src/lib/worktree.ts`) — reference only, never imported.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  /** Absolute path to the worktree directory. */
  path: string;
  branch: string;
  /** True for the primary clone (not a linked worktree). */
  isPrimary: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

/** Current branch of the worktree at `dir`. */
export async function currentBranch(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** List all worktrees of the repo containing `dir` (parsed from porcelain output). */
export async function listWorktrees(dir: string): Promise<Worktree[]> {
  const out = await git(dir, ["worktree", "list", "--porcelain"]);
  const trees: Worktree[] = [];
  let path = "";
  let branch = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace("refs/heads/", "");
    else if (line === "") {
      if (path) trees.push({ path, branch, isPrimary: trees.length === 0 });
      path = "";
      branch = "";
    }
  }
  if (path) trees.push({ path, branch, isPrimary: trees.length === 0 });
  return trees;
}

/**
 * Reject paths that escape the worktree root (PLAN R9: confine tools to the worktree;
 * reject `..`/symlink). Path-guard used by every file tool.
 */
export function isInsideWorktree(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : root + "/";
  return candidate === root || candidate.startsWith(normalizedRoot);
}

// TODO(P0): createWorktree / removeWorktree, nested-clone guard (assertPrimaryClone),
// per-worktree container + tmux pinning, drift watcher. See docs/PLAN.md § P0.
