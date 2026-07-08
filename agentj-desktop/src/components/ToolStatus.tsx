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
  const [tab, setTab] = useState<"servers" | "tools">("servers");

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
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const servers = data?.mcp ?? [];
  const toolCount = data ? data.builtins.length + data.mcpToolCount : 0;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal modal-tools" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="ts-tabs">
            <button
              className={tab === "servers" ? "ts-tab active" : "ts-tab"}
              onClick={() => setTab("servers")}
            >
              Servers{data ? ` · ${servers.length}` : ""}
            </button>
            <button
              className={tab === "tools" ? "ts-tab active" : "ts-tab"}
              onClick={() => setTab("tools")}
            >
              Tools{data ? ` · ${toolCount}` : ""}
            </button>
          </div>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body ts-body">
          {loading ? (
            <div className="set-empty">loading…</div>
          ) : error ? (
            <div className="set-empty">{error}</div>
          ) : tab === "servers" ? (
            servers.length === 0 ? (
              <div className="set-empty">No MCP servers. Add a .mcp.json to this repo.</div>
            ) : (
              <div className="ts-servers">
                {servers.map((s) => (
                  <div className="ts-server" key={s.name}>
                    <span className={"ts-pill ts-" + s.state}>{STATE_LABEL[s.state]}</span>
                    <span className="ts-server-name">{s.name}</span>
                    <span className="ts-server-count">{s.tools}</span>
                    {s.detail && <span className="ts-server-detail">{s.detail}</span>}
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="ts-tools">
              {data?.builtins.map((b) => (
                <div className="ts-tool" key={b.name} title={b.description}>
                  <span className="ts-tool-name">{b.name}</span>
                  <span className="ts-tool-desc">{b.description}</span>
                </div>
              ))}
              {data && data.mcpToolCount > 0 && (
                <div className="ts-note">+ {data.mcpToolCount} MCP tools — see Servers</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
