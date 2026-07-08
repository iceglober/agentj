import { useEffect, useState } from "react";
import { toolStatus } from "../session";
import type { McpServerStatus, ToolStatus as ToolStatusData } from "../types";

const STATE_LABEL: Record<McpServerStatus["state"], string> = {
  ok: "ok",
  needs_auth: "needs auth",
  error: "error",
};

export function ToolStatus({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<ToolStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Esc closes; handled at window level so it wins over the textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fetch on open for the active session.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    if (!sessionId) {
      setLoading(false);
      setError("No active session.");
      return;
    }
    setLoading(true);
    toolStatus(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">Tool status</h2>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="set-empty">loading…</div>
          ) : error ? (
            <div className="set-empty">{error}</div>
          ) : data ? (
            <>
              <div className="set-section" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
                <div className="set-section-head">Built-in tools</div>
                <div className="ts-builtins">
                  {data.builtins.map((b) => (
                    <div className="ts-builtin" key={b.name}>
                      <span className="ts-builtin-name">{b.name}</span>
                      <span className="ts-builtin-desc">{b.description}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="set-section">
                <div className="set-section-head">
                  MCP · {data.mcpToolCount} tools across {data.mcp.length} servers
                </div>
                {data.mcp.length === 0 ? (
                  <div className="set-empty">No MCP servers configured (.mcp.json).</div>
                ) : (
                  <div className="ts-servers">
                    {data.mcp.map((s) => (
                      <div className="ts-server" key={s.name}>
                        <div className="ts-server-top">
                          <span className={"ts-pill ts-" + s.state}>{STATE_LABEL[s.state]}</span>
                          <span className="ts-server-name">{s.name}</span>
                          <span className="ts-server-count">{s.tools} tools</span>
                        </div>
                        {s.detail && <div className="ts-server-detail">{s.detail}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
