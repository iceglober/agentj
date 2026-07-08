// Overlay shown after inspecting a git repo. Leads with a single primary
// "Continue" (provision a managed worktree off origin/<defaultBranch>); the
// existing worktrees hide behind a collapsed disclosure below it.

import { useState } from "react";
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
  const [showExisting, setShowExisting] = useState(false);
  const hasWorktrees = scan.worktrees.length > 0;

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

        {scan.isGit ? (
          <>
            <button
              className="chooser-continue"
              disabled={busy}
              onClick={() => onProvision(scan.base)}
            >
              {provisioning ? "provisioning…" : "Continue"}
            </button>
            <div className="chooser-continue-sub">
              Default: Managed Worktree
              <span className="chooser-continue-branch">
                origin/{scan.defaultBranch}
              </span>
            </div>

            {hasWorktrees && (
              <div className="chooser-disclosure">
                <button
                  className="chooser-disc-head"
                  aria-expanded={showExisting}
                  disabled={busy}
                  onClick={() => setShowExisting((v) => !v)}
                >
                  <span className={"chooser-disc-caret" + (showExisting ? " open" : "")}>
                    ▸
                  </span>
                  Existing worktree
                  <span className="chooser-disc-count">{scan.worktrees.length}</span>
                </button>

                {showExisting && (
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
                )}
              </div>
            )}
          </>
        ) : (
          <div className="chooser-error">not a git repository: {scan.base}</div>
        )}

        {error && <div className="chooser-error">{error}</div>}
      </div>
    </div>
  );
}
