import { createHash } from "node:crypto";
import { join } from "node:path";

const childTaskSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "task";

/** Keep each repository's temporary child worktrees separate without exposing its path. */
export const delegationWorktreeRoot = (temporaryRoot: string, commonGitDir: string): string =>
  join(
    temporaryRoot,
    "glorious-worktrees",
    createHash("sha256").update(commonGitDir).digest("hex").slice(0, 16),
  );

/**
 * Names must be unique across concurrent Glorious processes, not merely within a
 * single scheduler. The random instance segment avoids stale branches and
 * worktrees from previous sessions without deleting any uncertain work.
 */
export const createDelegationChildIdFactory = (
  instanceId: string = crypto.randomUUID().replaceAll("-", "").slice(0, 16),
): ((taskId: string) => string) => {
  let counter = 0;
  return (taskId: string): string => {
    counter += 1;
    return `job-${instanceId}-${counter.toString().padStart(4, "0")}-${childTaskSegment(taskId)}`;
  };
};
