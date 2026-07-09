import { useEffect, useState } from "react";
import type { FileEntry } from "../types";
import { listFiles, openPath } from "../session";

// One tree row. Folders load their children lazily on first expand and cache
// them; files open in the OS default app on click.
function TreeNode({ sessionId, entry }: { sessionId: string; entry: FileEntry }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const onClick = () => {
    if (!entry.isDir) {
      void openPath(sessionId, entry.rel);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) {
      setLoading(true);
      listFiles(sessionId, entry.rel)
        .then((kids) => setChildren(kids))
        .catch(() => setChildren([]))
        .finally(() => setLoading(false));
    }
  };

  return (
    <div className={"node" + (open ? " open" : "")}>
      <div className={"frow" + (entry.isDir ? "" : " file")} onClick={onClick}>
        <span className="tw">{entry.isDir ? "▸" : ""}</span>
        <span className="ic">{entry.isDir ? "📁" : "📄"}</span>
        {entry.name}
      </div>
      {entry.isDir && (
        <div className="children">
          {children?.map((c) => (
            <TreeNode key={c.rel} sessionId={sessionId} entry={c} />
          ))}
        </div>
      )}
    </div>
  );
}

// Lazy file explorer rooted at the session's worktree. Reloads the root when
// the session changes or `refreshKey` bumps; that unmounts every node, so all
// per-folder expand state resets cleanly.
export function FileTree({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  refreshKey: number;
}) {
  const [roots, setRoots] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    listFiles(sessionId, "")
      .then((r) => {
        if (!cancelled) setRoots(r);
      })
      .catch(() => {
        if (!cancelled) setRoots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  return (
    <div className="tree">
      {roots === null ? (
        <div className="tree-msg">loading…</div>
      ) : roots.length === 0 ? (
        <div className="tree-msg">no files</div>
      ) : (
        roots.map((e) => <TreeNode key={e.rel} sessionId={sessionId} entry={e} />)
      )}
    </div>
  );
}
