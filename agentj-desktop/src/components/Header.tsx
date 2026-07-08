import { useEffect, useRef, useState } from "react";
import { PhaseRail } from "./PhaseRail";
import type { Phase } from "../derive";
import type { RepoInfo } from "../types";

/** Show the trailing path segment(s) so the header stays short but recognizable. */
function shortRoot(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length <= 2 ? "/" + parts.join("/") : parts.slice(-2).join("/");
}

/** Just the final path segment — the repository's directory name. */
function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function Header({
  repo,
  recents,
  onPick,
  onOpenRecent,
  busy,
  phase,
}: {
  repo: RepoInfo | null;
  recents: string[];
  onPick: () => void;
  onOpenRecent: (path: string) => void;
  busy: boolean;
  phase: Phase | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close the recents menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const label = repo ? baseName(repo.base) : "no repo";
  const others = recents.filter((p) => p !== repo?.base);

  return (
    <div className="topbar">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
      <span className="brand">
        <b>agentj</b>
      </span>

      <span className="repoctl" ref={wrapRef}>
        <button
          className="repobtn"
          title={repo?.root ?? "choose a repository"}
          disabled={busy}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="folder">🗂</span>
          {repo?.branch ? (
            <span className="branch">⎇ {repo.branch}</span>
          ) : (
            <span className="reponame">{label}</span>
          )}
          {repo?.branch && <span className="reponame dim">{label}</span>}
          {repo?.isWorktree && <span className="wtbadge">worktree</span>}
          <span className="chev">▾</span>
        </button>
        {busy && <span className="repolock" title="interrupt the turn to switch workspaces">🔒</span>}

        {menuOpen && (
          <div className="repomenu">
            <button
              className="repomenu-item pick"
              onClick={() => {
                setMenuOpen(false);
                onPick();
              }}
            >
              Open a repository…
            </button>
            {others.length > 0 && <div className="repomenu-sep">recent</div>}
            {others.map((p) => (
              <button
                key={p}
                className="repomenu-item recent"
                title={p}
                onClick={() => {
                  setMenuOpen(false);
                  onOpenRecent(p);
                }}
              >
                {shortRoot(p)}
                <span className="fullpath">{p}</span>
              </button>
            ))}
          </div>
        )}
      </span>

      <PhaseRail phase={phase} />
    </div>
  );
}
