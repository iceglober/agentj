// The signature chrome: a two-tier tab bar at the top of the window.
//   TIER 1 — projects: one tab per distinct base repo among the open sessions.
//   TIER 2 — sessions: only the active project's sessions (worktrees).
// Tier 2 visually nests under the active project. All grotesk (--sans).

import type { SessionMeta } from "../types";

interface Project {
  base: string;
  projectName: string;
}

function branchLabel(s: SessionMeta): string {
  return s.branch ?? "detached";
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
        <span className="wordmark">agentj</span>
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
