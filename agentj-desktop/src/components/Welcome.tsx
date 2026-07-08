// Empty state shown when no workspace is active. Opens a repo via the native
// folder picker or a remembered base-repo path from localStorage.

/** Show the trailing path segment(s) so recents stay short but recognizable. */
function shortRoot(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length <= 2 ? "/" + parts.join("/") : parts.slice(-2).join("/");
}

export function Welcome({
  recents,
  onOpen,
  onOpenRecent,
  error,
}: {
  recents: string[];
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  error: string | null;
}) {
  return (
    <div className="welcome">
      <div className="wcard">
        <div className="wbrand">agentj</div>
        <div className="wtitle">Open a repository to start a workspace</div>
        <div className="wsub">
          agentj works in a dedicated git worktree, so it never touches your checkout.
        </div>

        <button className="wopen" onClick={onOpen}>
          <span className="folder">🗂</span> Open a repository
        </button>

        {error && <div className="werror">{error}</div>}

        {recents.length > 0 && (
          <div className="wrecents">
            <div className="wrecents-head">recent repositories</div>
            {recents.map((p) => (
              <button
                key={p}
                className="wrecent"
                title={p}
                onClick={() => onOpenRecent(p)}
              >
                <span className="wrecent-name">{shortRoot(p)}</span>
                <span className="wrecent-path">{p}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
