// Overlay shown after inspecting a git repo: create a fresh worktree off
// origin/<defaultBranch>, or resume an existing worktree / the base checkout.

import type { RepoScan } from "../types";

function shortRoot(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length <= 2 ? "/" + parts.join("/") : parts.slice(-2).join("/");
}

export function WorkspaceChooser({
  scan,
  provisioning,
  error,
  onProvision,
  onOpen,
  onClose,
}: {
  scan: RepoScan;
  provisioning: boolean;
  error: string | null;
  onProvision: (base: string) => void;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const busy = provisioning;

  return (
    <div className="chooser-scrim" onClick={busy ? undefined : onClose}>
      <div className="chooser" onClick={(e) => e.stopPropagation()}>
        <div className="chooser-head">
          <div className="chooser-repo">{scan.baseName}</div>
          <div className="chooser-base" title={scan.base}>
            {scan.base}
          </div>
          <button className="chooser-x" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        <button
          className="chooser-new"
          disabled={busy}
          onClick={() => onProvision(scan.base)}
        >
          <span className="chooser-new-title">
            {provisioning ? "provisioning…" : "New worktree"}
          </span>
          <span className="chooser-new-sub">
            off <code>origin/{scan.defaultBranch}</code>
          </span>
        </button>

        {scan.worktrees.length > 0 && (
          <>
            <div className="chooser-sep">resume a worktree</div>
            <div className="chooser-list">
              {scan.worktrees.map((w) => (
                <button
                  key={w.path}
                  className="chooser-wt"
                  title={w.path}
                  disabled={busy}
                  onClick={() => onOpen(w.path)}
                >
                  <span className="chooser-wt-top">
                    <span className="chooser-wt-branch">
                      ⎇ {w.branch ?? "(detached)"}
                    </span>
                    {w.isMain && <span className="badge base">main</span>}
                    {w.isActive && <span className="badge active">active</span>}
                  </span>
                  <span className="chooser-wt-path">{shortRoot(w.path)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && <div className="chooser-error">{error}</div>}
      </div>
    </div>
  );
}
