import type { Sandbox } from "../sandbox";
import { shq } from "../shell";

/**
 * Undo/redo over the agent's file changes, using the same temp-index snapshot
 * and verified binary-patch techniques as workspace/git-integration.ts, under
 * a dedicated ref namespace (`refs/agentj/undo/<session>/<n>`). Snapshots and
 * restores never touch HEAD, the user's index, or any branch.
 */

export interface UndoSnapshot {
  ref: string;
  commit: string;
  tree: string;
  label: string;
}

export interface UndoStack {
  /** Record the current tree; returns null when nothing changed since the
   *  snapshot the stack currently points at. Truncates any redo branch. */
  snapshot(label: string): Promise<UndoSnapshot | null>;
  /** Restore the previous snapshot; returns its label, or null at the bottom.
   *  The pre-undo state is snapshotted first, so it stays redoable. */
  undo(): Promise<string | null>;
  /** Re-apply the next snapshot; null at the top or after new changes. */
  redo(): Promise<string | null>;
  /** Remove scratch files and prune all but the newest `keep` refs. */
  dispose(keep?: number): Promise<void>;
}

const IDENTITY =
  "GIT_AUTHOR_NAME=agentj GIT_AUTHOR_EMAIL=agentj@sandbox.local " +
  "GIT_COMMITTER_NAME=agentj GIT_COMMITTER_EMAIL=agentj@sandbox.local ";

export function createUndoStack(
  environment: Sandbox,
  repoRoot: string,
  sessionId: string,
): UndoStack {
  const git = (args: string): string => `git -C ${shq(repoRoot)} ${args}`;
  const run = async (command: string): Promise<string> => {
    const result = await environment.executeCommand(command);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `command exited ${result.exitCode}`);
    }
    return result.stdout.trim();
  };

  const scratch = `/tmp/agentj-undo-${sessionId}`;
  const entries: UndoSnapshot[] = [];
  let pointer = -1;
  let counter = 0;

  const currentTree = async (): Promise<string> => {
    const index = `${scratch}/tree.index`;
    await run(`mkdir -p ${shq(scratch)}`);
    const head = await run(git("rev-parse -q --verify 'HEAD^{commit}'"));
    await run(`GIT_INDEX_FILE=${shq(index)} ${git(`read-tree ${shq(`${head}^{tree}`)}`)}`);
    await run(`GIT_INDEX_FILE=${shq(index)} ${git("add -A -- .")}`);
    return run(`GIT_INDEX_FILE=${shq(index)} ${git("write-tree")}`);
  };

  /** Verified aggregate binary patch from one snapshot's tree to another's. */
  const applyDiff = async (from: UndoSnapshot, to: UndoSnapshot): Promise<void> => {
    if (from.tree === to.tree) return;
    const patch = `${scratch}/restore-${counter}.patch`;
    await run(
      git(
        `diff-tree --no-commit-id --no-ext-diff --no-textconv --no-renames --binary --full-index -p --output=${shq(patch)} ${shq(from.commit)} ${shq(to.commit)} --`,
      ),
    );
    await run(git(`apply --check --binary ${shq(patch)}`));
    await run(git(`apply --binary ${shq(patch)}`));
  };

  const snapshot = async (label: string): Promise<UndoSnapshot | null> => {
    const tree = await currentTree();
    if (pointer >= 0 && entries[pointer]?.tree === tree) return null;
    const head = await run(git("rev-parse -q --verify 'HEAD^{commit}'"));
    counter += 1;
    const commit = await run(
      `${IDENTITY}${git(`commit-tree ${shq(tree)} -p ${shq(head)} -m ${shq(`agentj undo: ${label}`)}`)}`,
    );
    const ref = `refs/agentj/undo/${sessionId}/${counter}`;
    await run(git(`update-ref -m ${shq("agentj undo snapshot")} ${shq(ref)} ${shq(commit)} ''`));
    entries.splice(pointer + 1);
    entries.push({ ref, commit, tree, label });
    pointer = entries.length - 1;
    return entries[pointer] ?? null;
  };

  return {
    snapshot,

    async undo() {
      // Capture drift since the last snapshot so the pre-undo state is redoable.
      await snapshot("pre-undo");
      if (pointer <= 0) return null;
      const from = entries[pointer];
      const to = entries[pointer - 1];
      if (!from || !to) return null;
      await applyDiff(from, to);
      pointer -= 1;
      return to.label;
    },

    async redo() {
      if (pointer < 0 || pointer >= entries.length - 1) return null;
      const from = entries[pointer];
      const to = entries[pointer + 1];
      if (!from || !to) return null;
      // New changes since the restore invalidate the redo branch.
      if ((await currentTree()) !== from.tree) return null;
      await applyDiff(from, to);
      pointer += 1;
      return to.label;
    },

    async dispose(keep = 20) {
      await environment.executeCommand(`rm -rf ${shq(scratch)}`);
      for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
        await environment.executeCommand(git(`update-ref -d ${shq(entry.ref)}`));
      }
    },
  };
}
