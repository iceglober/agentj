import type { SessionMeta } from "../types";

// Classic Windows status bar at the bottom of the window: workspace metadata for the active session
// (branch, project, worktree state, path) + the session's model (click to change). Live turn activity
// lives in the chat's StatusRow instead.
export function StatusBar({
  meta,
  onOpenModels,
}: {
  meta: SessionMeta | null;
  onOpenModels: () => void;
}) {
  if (!meta) {
    return (
      <div className="statusbar">
        <span className="sb-seg sb-flex">No workspace open</span>
      </div>
    );
  }
  return (
    <div className="statusbar">
      <span className="sb-seg sb-branch" title={meta.branch ?? "detached HEAD"}>
        ⎇ {meta.branch ?? "detached"}
      </span>
      <span className="sb-seg" title={meta.base}>
        📁 {meta.projectName}
      </span>
      <span className="sb-seg">{meta.isWorktree ? "worktree" : "base checkout"}</span>
      <span className="sb-seg sb-flex sb-path" title={meta.root}>
        {meta.root}
      </span>
      <button
        className="sb-seg sb-model"
        title="Change this session's model"
        onClick={onOpenModels}
      >
        ⚙ {meta.model || "(no model)"}
      </button>
    </div>
  );
}
