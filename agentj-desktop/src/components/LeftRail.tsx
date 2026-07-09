import { useMemo, useState } from "react";
import { parseTodos } from "../todos";
import { Todos } from "./Todos";
import { FileTree } from "./FileTree";

const RAIL_KEY = "agentj.rail";

function loadCollapsed(): boolean {
  return localStorage.getItem(RAIL_KEY) === "1";
}

// Collapsible left rail: a live Todos section (only when the session has
// parseable todos) over a file explorer that fills the rest. Collapses to a
// sliver so the chat can go full-width; the collapsed state persists.
export function LeftRail({
  sessionId,
  todos,
}: {
  sessionId: string;
  todos: string | null;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const [todosOpen, setTodosOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const items = useMemo(() => (todos ? parseTodos(todos) : []), [todos]);
  const hasTodos = items.length > 0;
  const done = items.filter((i) => i.state === "done").length;

  const toggleRail = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      return next;
    });
  };

  if (collapsed) {
    return (
      <div className="leftrail collapsed">
        <div className="railbar">
          <span className="railtoggle" onClick={toggleRail} title="Expand rail">
            ›
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="leftrail">
      <div className="railbar">
        <span>workspace</span>
        <span className="railtoggle" onClick={toggleRail} title="Collapse rail">
          ‹
        </span>
      </div>

      {hasTodos && (
        <div className="section todos-sec">
          <div className="shead" onClick={() => setTodosOpen((v) => !v)}>
            <span className="tw">{todosOpen ? "▾" : "▸"}</span> Todos
            <span className="count">
              {done}/{items.length}
            </span>
          </div>
          {todosOpen && <Todos items={items} />}
        </div>
      )}

      <div className="section files">
        <div className="shead" onClick={() => setFilesOpen((v) => !v)}>
          <span className="tw">{filesOpen ? "▾" : "▸"}</span> Files
          <span
            className="srefresh"
            title="Refresh files"
            onClick={(e) => {
              e.stopPropagation();
              setRefreshKey((k) => k + 1);
            }}
          >
            ⟳
          </span>
        </div>
        {filesOpen && (
          <div className="secbody files-body">
            <FileTree sessionId={sessionId} refreshKey={refreshKey} />
          </div>
        )}
      </div>
    </div>
  );
}
