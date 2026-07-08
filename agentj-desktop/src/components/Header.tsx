import { useEffect, useRef, useState } from "react";
import { PhaseRail } from "./PhaseRail";
import type { Phase } from "../derive";
import type { RepoInfo } from "../types";

/** Show the trailing path segment(s) so the header stays short but recognizable. */
function shortRoot(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length <= 2 ? "/" + parts.join("/") : parts.slice(-2).join("/");
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

  const label = repo ? shortRoot(repo.root) : "no repo";
  const others = recents.filter((p) => p !== repo?.root);

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
          title={repo?.root ?? "choose a working directory"}
          disabled={busy}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="folder">🗂</span>
          <span className="reponame">{label}</span>
          {repo?.branch && <span className="branch">⎇ {repo.branch}</span>}
          <span className="chev">▾</span>
        </button>
        {busy && <span className="repolock" title="interrupt the turn to switch repos">🔒</span>}

        {menuOpen && (
          <div className="repomenu">
            <button
              className="repomenu-item pick"
              onClick={() => {
                setMenuOpen(false);
                onPick();
              }}
            >
              Open repo…
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
