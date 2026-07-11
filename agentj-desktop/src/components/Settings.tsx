// Settings modal with a sidebar: General (display toggles + session info), then a Project group
// whose items (Hooks / Agent settings / MCP servers) each open their own controlled pane
// (see ProjectPane).
import { useEffect, useState } from "react";
import type { Settings as SettingsValues } from "../settings";
import type { SessionMeta } from "../types";
import { ProjectPane } from "./ProjectConfig";

interface Toggle {
  key: keyof SettingsValues;
  label: string;
  hint: string;
}

const TOGGLES: Toggle[] = [
  { key: "showThinking", label: "Show thinking", hint: "Display the agent's reasoning blocks." },
  { key: "showTools", label: "Show tool calls", hint: "Display tool calls in the transcript." },
  { key: "autoScroll", label: "Auto-scroll to latest", hint: "Follow the transcript as new output lands." },
];

export type SettingsTab = "general" | "hooks" | "agent" | "mcp";

const PROJECT_ITEMS: { id: SettingsTab; label: string }[] = [
  { id: "hooks", label: "Hooks" },
  { id: "agent", label: "Agent settings" },
  { id: "mcp", label: "MCP servers" },
];

export function Settings({
  settings,
  onSet,
  onClose,
  meta,
  totalTokens,
  initialTab = "general",
}: {
  settings: SettingsValues;
  onSet: (key: keyof SettingsValues, value: boolean) => void;
  onClose: () => void;
  meta: SessionMeta | null;
  totalTokens: number;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

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

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal modal-wide set-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">Settings</h2>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="set-body">
          <nav className="set-side" aria-label="Settings sections">
            <button
              className={"set-side-item" + (tab === "general" ? " sel" : "")}
              onClick={() => setTab("general")}
            >
              General
            </button>
            <div className="set-side-group">Project</div>
            {PROJECT_ITEMS.map((item) => (
              <button
                key={item.id}
                className={"set-side-item child" + (tab === item.id ? " sel" : "")}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="set-pane">
            {tab === "general" ? (
              <>
                <div className="set-group">
                  {TOGGLES.map((t) => (
                    <label className="set-row" key={t.key}>
                      <span className="set-text">
                        <span className="set-label">{t.label}</span>
                        <span className="set-hint">{t.hint}</span>
                      </span>
                      <button
                        role="switch"
                        aria-checked={settings[t.key]}
                        aria-label={t.label}
                        className={"switch" + (settings[t.key] ? " on" : "")}
                        onClick={() => onSet(t.key, !settings[t.key])}
                      >
                        <span className="knob" />
                      </button>
                    </label>
                  ))}
                </div>

                <div className="set-section">
                  <div className="set-section-head">Session</div>
                  {meta ? (
                    <dl className="set-info">
                      <dt>Branch</dt>
                      <dd>{meta.branch ?? "detached"}</dd>
                      <dt>Worktree</dt>
                      <dd className="mono-path">{meta.root}</dd>
                      <dt>Tokens</dt>
                      <dd>{(totalTokens / 1000).toFixed(1)}k</dd>
                    </dl>
                  ) : (
                    <div className="set-empty">No active session.</div>
                  )}
                </div>
              </>
            ) : (
              <ProjectPane sessionId={meta?.id ?? null} section={tab} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
