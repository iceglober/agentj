// The signature chrome: a two-tier tab bar at the top of the window.
//   TIER 1 — projects: one tab per distinct base repo among the open sessions.
//   TIER 2 — sessions: only the active project's sessions (worktrees).
// Tier 2 visually nests under the active project. All grotesk (--sans).

import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "../types";

interface Project {
  base: string;
  projectName: string;
}

function branchLabel(s: SessionMeta): string {
  return s.branch ?? "detached";
}

// Small inline gear — no icon library. Inherits color via currentColor.
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GearMenu({
  onOpenSettings,
  onOpenShortcuts,
}: {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div className="gearwrap" ref={ref}>
      <button
        className={"gearbtn" + (open ? " open" : "")}
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </button>
      {open && (
        <div className="repomenu" role="menu">
          <button className="repomenu-item" role="menuitem" onClick={() => pick(onOpenSettings)}>
            Settings
          </button>
          <button className="repomenu-item" role="menuitem" onClick={() => pick(onOpenShortcuts)}>
            Keyboard shortcuts
          </button>
        </div>
      )}
    </div>
  );
}

export function TabBar({
  sessions,
  activeProject,
  activeId,
  runningIds,
  provisioning,
  onSelectProject,
  onSelectSession,
  onCloseSession,
  onNewProject,
  onNewSession,
  onOpenSettings,
  onOpenShortcuts,
}: {
  sessions: SessionMeta[];
  activeProject: string | null;
  activeId: string | null;
  runningIds: Set<string>;
  provisioning: boolean;
  onSelectProject: (base: string) => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewProject: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  // Distinct projects, in first-seen order.
  const projects: Project[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (!seen.has(s.base)) {
      seen.add(s.base);
      projects.push({ base: s.base, projectName: s.projectName });
    }
  }

  const tier2 = sessions.filter((s) => s.base === activeProject);

  return (
    <div className="tabbar">
      {/* tier 1 — projects */}
      <div className="tier tier1">
        <GearMenu onOpenSettings={onOpenSettings} onOpenShortcuts={onOpenShortcuts} />
        <div className="tabs">
          {projects.map((p) => (
            <button
              key={p.base}
              className={"ptab" + (p.base === activeProject ? " active" : "")}
              title={p.base}
              onClick={() => onSelectProject(p.base)}
            >
              <span className="ptab-name">{p.projectName}</span>
            </button>
          ))}
          <button
            className="newtab"
            title="Open another project"
            onClick={onNewProject}
          >
            +
          </button>
        </div>
      </div>

      {/* tier 2 — sessions of the active project */}
      <div className="tier tier2">
        <div className="tabs">
          {tier2.map((s) => {
            const live = runningIds.has(s.id);
            return (
              <div
                key={s.id}
                className={"stab" + (s.id === activeId ? " active" : "")}
                title={s.root}
                onClick={() => onSelectSession(s.id)}
              >
                {live && <span className="livedot" aria-label="running" />}
                <span className="stab-branch">{branchLabel(s)}</span>
                <button
                  className="stab-x"
                  aria-label="Close session"
                  title="Close session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            className="newtab"
            title="New worktree in this project"
            disabled={provisioning || activeProject == null}
            onClick={onNewSession}
          >
            {provisioning ? "…" : "+"}
          </button>
        </div>
      </div>
    </div>
  );
}
