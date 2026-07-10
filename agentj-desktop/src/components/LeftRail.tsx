import { useEffect, useMemo, useRef, useState } from "react";
import { parseTodos } from "../todos";
import { Todos } from "./Todos";
import { FileTree } from "./FileTree";

const RAIL_KEY = "agentj.rail";
const SPLIT_KEY = "agentj.rail.split";

function loadCollapsed(): boolean {
  return localStorage.getItem(RAIL_KEY) === "1";
}
function loadSplit(): number {
  const v = parseFloat(localStorage.getItem(SPLIT_KEY) ?? "");
  return Number.isFinite(v) && v > 0.1 && v < 0.9 ? v : 0.4;
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// Collapsible left rail: a live Todos section over a file explorer. Each pane collapses to just its
// header; the OPEN panes flex-grow to share the space (so collapsing one gives its room to the
// other). When both are open a draggable divider between them sets the split. The whole rail also
// collapses to a sliver; both states persist.
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
  const [split, setSplit] = useState<number>(loadSplit);
  const panesRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => (todos ? parseTodos(todos) : []), [todos]);
  const hasTodos = items.length > 0;
  const done = items.filter((i) => i.state === "done").length;

  useEffect(() => {
    localStorage.setItem(SPLIT_KEY, String(split));
  }, [split]);

  const toggleRail = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      return next;
    });
  };

  // Drag the divider: convert vertical mouse travel into a change in the top pane's share.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const region = panesRef.current?.clientHeight ?? 1;
    const startY = e.clientY;
    const start = split;
    const onMove = (me: MouseEvent) => {
      setSplit(clamp(start + (me.clientY - startY) / Math.max(region, 1), 0.12, 0.88));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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

  const showDivider = hasTodos && todosOpen && filesOpen;

  return (
    <div className="leftrail">
      <div className="railbar">
        <span>workspace</span>
        <span className="railtoggle" onClick={toggleRail} title="Collapse rail">
          ‹
        </span>
      </div>

      <div className="railpanes" ref={panesRef}>
        {hasTodos && (
          <div
            className={"section todos-sec" + (todosOpen ? " open" : "")}
            style={todosOpen ? { flexGrow: split } : undefined}
          >
            <div className="shead" onClick={() => setTodosOpen((v) => !v)}>
              <span className="tw">{todosOpen ? "▾" : "▸"}</span> Todos
              <span className="count">
                {done}/{items.length}
              </span>
            </div>
            {todosOpen && <Todos items={items} />}
          </div>
        )}

        {showDivider && (
          <div className="panediv" onMouseDown={startDrag} title="Drag to resize" />
        )}

        <div
          className={"section files" + (filesOpen ? " open" : "")}
          style={filesOpen ? { flexGrow: 1 - split } : undefined}
        >
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
    </div>
  );
}
